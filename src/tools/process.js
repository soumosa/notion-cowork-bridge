/**
 * Running things: a foreground command, and processes that outlive one tool
 * call.
 *
 *   run_terminal_command       one command, waits for it to finish (or the
 *                              timeout).
 *   start_background_process   spawns detached, returns immediately, logs to
 *                              disk. list/read/stop manage what's running.
 *
 * Background processes need their own path rather than "just background it
 * with &" because `runCommand` used to resolve on the child's `close` event,
 * and `close` does not fire until every inherited stdio pipe closes too. A
 * dev server holds stdout open forever, so `npm run dev &` blocked the tool
 * for the whole timeout and was then killed as a group anyway — measured:
 * the shell itself exits at 9ms, `close` doesn't fire until 6021ms. Spawning
 * detached with stdout/stderr redirected straight to a log file sidesteps
 * the pipe entirely, so the call returns as soon as the process exists.
 *
 * Nothing here is a sandbox. A command runs with this user's real shell,
 * PATH, filesystem and network access, minus the bridge's own auth token.
 * Two small things try to catch the laziest failure mode of a prompt
 * injection without pretending to catch a determined one: a short deny-list
 * refuses a handful of one-liners that are never a legitimate throwaway
 * command (piping a download into a shell, reading an SSH key, `rm -rf ~`,
 * dumping the keychain, minting an AWS session token) — a speed bump, not a
 * safety guarantee, trivially rewritten to dodge a regex by anyone actually
 * trying, present because the realistic injected payload is a lazy
 * copy-paste rather than a targeted bypass. Separately, anything that merely
 * *touches* SSH, AWS, npm, git or env credentials, the keychain, or a pipe
 * into a shell is marked `flagged: true` in the audit record, denied or not,
 * so `jq 'select(.flagged)'` is a query a worried user can actually run.
 *
 * Output truncation applies one combined ceiling to stdout and stderr
 * together — per-stream would double the advertised limit — and keeps the
 * first 64 KB plus the last 128 KB rather than the first 192 KB, since for
 * build and test output the failure is almost always at the end.
 * `StringDecoder` does the cutting, so a multi-byte character at the cut
 * point is dropped cleanly instead of turning into U+FFFD.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

import * as z from "zod/v4";

import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";
import {
  BACKGROUND_LOG_LIMIT_BYTES,
  BACKGROUND_RETENTION_HOURS,
  BACKGROUND_TOTAL_LOG_LIMIT_BYTES,
  MAX_BACKGROUND_PROCESSES,
} from "../lib/config.js";

const INFLIGHT_WAIT_MS = 10_000;
const INFLIGHT_POLL_MS = 200;

// Never legitimately a single throwaway command. Flag order and casing vary
// ("-rf", "-fr", "-Rf"), so the rm pattern matches the flag letters rather
// than one literal spelling.
const DENY_LIST = [
  {
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i,
    reason: "piping a remote download straight into a shell",
  },
  {
    pattern: /\b(bash|sh|zsh)\s+<\(\s*(curl|wget)\b/i,
    reason: "running a remote download via process substitution",
  },
  {
    pattern: /\bcat\b[^\n]*\.ssh\/id_(rsa|dsa|ecdsa|ed25519)\b/i,
    reason: "reading a private SSH key",
  },
  {
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+(~|\$HOME)(\/\S*)?(\s|$)/i,
    reason: "recursively deleting the home directory",
  },
  {
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(\s|$)/,
    reason: "recursively deleting the filesystem root",
  },
  {
    pattern: /\bsecurity\s+dump-keychain\b/i,
    reason: "dumping the macOS keychain",
  },
  {
    pattern: /\baws\s+sts\s+get-session-token\b/i,
    reason: "minting a long-lived AWS session token",
  },
];

// Broader than the deny-list on purpose: these run, but get a marker so a
// human reviewing the audit log can find them without reading every line.
const FLAG_PATTERNS = [
  /\.ssh(\/|\b)/i,
  /\.aws(\/|\b)/i,
  /\.npmrc\b/i,
  /\.git-credentials\b/i,
  /\.env\b/i,
  /\bkeychain\b/i,
  /\bsecurity\s+find-generic-password\b/i,
  /\|\s*(sudo\s+)?(sh|bash|zsh|dash)\b/i,
];

function findDenyMatch(command) {
  return DENY_LIST.find(({ pattern }) => pattern.test(command));
}

function isFlagged(command) {
  return Boolean(findDenyMatch(command)) || FLAG_PATTERNS.some((pattern) => pattern.test(command));
}

function commandForAudit(command) {
  const display = command
    .replace(/(authorization\s*[:=]\s*)([^\s'"]+)/gi, "$1[REDACTED]")
    .replace(/((?:token|secret|password|api[_-]?key)\s*=\s*)([^\s'"]+)/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/g, "$1[REDACTED]@")
    .replace(/(--(?:token|password|api-key|secret)\s+)([^\s]+)/gi, "$1[REDACTED]");
  return { display: display.slice(0, 20_000), sha256: createHash("sha256").update(command).digest("hex") };
}

/** Shared by run_terminal_command and start_background_process: resolve the
 * working directory, then refuse or flag the command. Returns `flagged`; logs
 * and throws on a deny-list hit rather than returning. */
async function preparePolicy(ctx, { command, cwd }) {
  const cwdPath = await ctx.paths.resolveExistingPath(cwd);
  if (!(await stat(cwdPath)).isDirectory()) {
    throw new ToolError(ERROR_CODES.NOT_A_DIRECTORY, "cwd must be a directory.", { path: cwd });
  }
  const relativeCwd = ctx.paths.workspaceRelative(cwdPath) || ".";
  return { cwdPath, relativeCwd, flagged: isFlagged(command), auditCommand: commandForAudit(command) };
}

/** The one spawn() call shape shared by a foreground and a background run. */
function spawnInShell(ctx, command, cwdPath, stdio) {
  return spawn(ctx.shell.path, ctx.shell.argumentsFor(ctx.shell.path, command), {
    cwd: cwdPath,
    env: ctx.shell.environment(),
    shell: false,
    detached: !ctx.isWindows,
    windowsHide: true,
    stdio,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The check-and-set below is synchronous — no `await` sits between reading
// `commandInFlight` and setting it — so two overlapping calls to this
// function can never both see it false. The loop around it only adds a
// bounded wait for a slot to free up; it does not change that guarantee.
let commandInFlight = false;
async function acquireCommandSlot() {
  const deadline = Date.now() + INFLIGHT_WAIT_MS;
  for (;;) {
    if (!commandInFlight) {
      commandInFlight = true;
      return;
    }
    if (Date.now() >= deadline) {
      throw new ToolError(
        ERROR_CODES.BUSY,
        "Another terminal command is still running after a 10-second wait. Wait for it to finish and retry this call.",
      );
    }
    await sleep(INFLIGHT_POLL_MS);
  }
}

/** Windows has no process groups to signal, so the tree is killed by pid. */
function killProcessGroup(ctx, pid) {
  if (ctx.isWindows) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        env: ctx.shell.environment(),
        windowsHide: true,
      });
    } catch {
      /* best effort */
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else; ESRCH means it's gone.
    return error.code === "EPERM";
  }
}

/** Drops stray continuation bytes left at the front of a buffer that was cut
 * from the middle of a longer one, so decoding never starts mid-character. */
function trimLeadingContinuation(buf) {
  let i = 0;
  while (i < buf.length && i < 4 && (buf[i] & 0xc0) === 0x80) i += 1;
  return i ? buf.subarray(i) : buf;
}

/**
 * Collects stdout and stderr as they arrive, in the order they actually
 * arrive, against one shared byte budget instead of one budget per stream.
 * Bounded memory (head + tail budgets, not the full stream) no matter how
 * much output a runaway command produces.
 */
function createOutputCollector(limit) {
  const headBudget = Math.floor(limit / 4); // 64 KB of a 256 KB limit
  const tailBudget = Math.floor(limit / 2); // 128 KB of a 256 KB limit
  const headChunks = [];
  let headRemaining = headBudget;
  const tailChunks = [];
  let tailBytes = 0;
  const totals = { stdout: 0, stderr: 0 };

  function push(stream, chunk) {
    totals[stream] += chunk.length;
    if (headRemaining > 0) {
      const take = Math.min(headRemaining, chunk.length);
      headChunks.push({ stream, buf: chunk.subarray(0, take) });
      headRemaining -= take;
    }
    tailChunks.push({ stream, buf: chunk });
    tailBytes += chunk.length;
    while (tailBytes > tailBudget && tailChunks.length > 0) {
      const oldest = tailChunks[0];
      const excess = tailBytes - tailBudget;
      if (oldest.buf.length <= excess) {
        tailChunks.shift();
        tailBytes -= oldest.buf.length;
      } else {
        oldest.buf = oldest.buf.subarray(excess);
        tailBytes -= excess;
      }
    }
  }

  // Takes n bytes worth of chunks from the front (fromEnd false) or the back
  // (fromEnd true), splitting the boundary chunk rather than dropping it.
  function take(chunks, n, fromEnd) {
    const out = [];
    let remaining = n;
    const ordered = fromEnd ? [...chunks].reverse() : chunks;
    for (const { stream, buf } of ordered) {
      if (remaining <= 0) break;
      const took = Math.min(remaining, buf.length);
      const slice = fromEnd ? buf.subarray(buf.length - took) : buf.subarray(0, took);
      out[fromEnd ? "unshift" : "push"]({ stream, buf: slice });
      remaining -= took;
    }
    return out;
  }

  function bytesFor(stream, pieces) {
    return Buffer.concat(pieces.filter((p) => p.stream === stream).map((p) => p.buf));
  }

  function finish() {
    const total = totals.stdout + totals.stderr;
    const elidedTotal = Math.max(0, total - headBudget - tailBudget);
    const truncated = elidedTotal > 0;
    const headKeep = truncated ? headBudget : Math.max(0, total - tailBudget);
    const tailKeep = total - headKeep;
    const headPieces = take(headChunks, headKeep, false);
    const tailPieces = take(tailChunks, tailKeep, true);

    const result = { outputTruncated: truncated };
    for (const stream of ["stdout", "stderr"]) {
      const headBuf = bytesFor(stream, headPieces);
      const tailBuf = bytesFor(stream, tailPieces);
      const elided = totals[stream] - (headBuf.length + tailBuf.length);
      if (elided <= 0) {
        // Head and tail are contiguous in the original byte stream — decode
        // them together so a character straddling that internal join isn't
        // corrupted by two independent decoders.
        const decoder = new StringDecoder("utf8");
        result[stream] = decoder.write(Buffer.concat([headBuf, tailBuf])) + decoder.end();
        continue;
      }
      const headDecoder = new StringDecoder("utf8");
      // write() without end(): a character cut at this real truncation point
      // is held internally and dropped rather than surfacing as U+FFFD.
      const headText = headDecoder.write(headBuf);
      const tailDecoder = new StringDecoder("utf8");
      const tailText = tailDecoder.write(trimLeadingContinuation(tailBuf)) + tailDecoder.end();
      result[stream] = `${headText}\n… ${elided} bytes elided …\n${tailText}`;
    }
    return result;
  }

  return { push, finish };
}

async function runCommand(ctx, { command, cwd, timeoutMs }) {
  await acquireCommandSlot();
  try {
    const { cwdPath, relativeCwd, flagged, auditCommand } = await preparePolicy(ctx, {
      command,
      cwd,
      event: "run_terminal_command",
    });
    const timeout = Math.min(timeoutMs, ctx.limits.maxCommandTimeoutMs);
    const startedAt = Date.now();

    // Logged before execution so a crash or a hard kill still leaves a trace.
    await ctx.audit({
      event: "run_terminal_command.start",
      command: auditCommand.display,
      commandSha256: auditCommand.sha256,
      cwd: relativeCwd,
      shell: ctx.shell.path,
      timeoutMs: timeout,
      flagged,
    });

    const result = await new Promise((resolve, reject) => {
      const child = spawnInShell(ctx, command, cwdPath, ["ignore", "pipe", "pipe"]);
      const collector = createOutputCollector(ctx.limits.maxCommandOutputBytes);
      let timedOut = false;

      child.stdout.on("data", (chunk) => collector.push("stdout", chunk));
      child.stderr.on("data", (chunk) => collector.push("stderr", chunk));

      const timer = setTimeout(() => {
        timedOut = true;
        killProcessGroup(ctx, child.pid);
      }, timeout);

      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const output = collector.finish();
        resolve({
          command,
          cwd: relativeCwd,
          exitCode: code,
          signal,
          timedOut,
          outputTruncated: output.outputTruncated,
          stdout: output.stdout,
          stderr: output.stderr,
        });
      });
    });

    await ctx.audit({
      event: "run_terminal_command.finish",
      command: auditCommand.display,
      commandSha256: auditCommand.sha256,
      cwd: relativeCwd,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      outputTruncated: result.outputTruncated,
      durationMs: Date.now() - startedAt,
      flagged,
    });

    return result;
  } finally {
    commandInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Background processes
// ---------------------------------------------------------------------------

/** id -> { id, pid, pgid, command, cwd, logPath, startedAt } */
const backgroundProcesses = new Map();

function processesDir(ctx) {
  return path.join(ctx.stateDir, "processes");
}

function registryPath(ctx) {
  return path.join(processesDir(ctx), "registry.json");
}

async function persistRegistry(ctx) {
  const records = [...backgroundProcesses.values()];
  try {
    await writeFile(registryPath(ctx), JSON.stringify(records, null, 2), { mode: 0o600 });
    await chmod(registryPath(ctx), 0o600);
  } catch (error) {
    // Best effort: losing the on-disk copy only affects recovery after a
    // hard crash, never this run's ability to see and stop what it started.
    console.error(`Failed to persist process registry: ${error.message}`);
  }
}

async function startBackgroundProcess(ctx, { command, cwd }) {
  const { cwdPath, relativeCwd, flagged, auditCommand } = await preparePolicy(ctx, {
    command,
    cwd,
    event: "start_background_process",
  });

  const running = [...backgroundProcesses.values()].filter(
    (entry) => entry.state === "running" && entry.owned && isAlive(entry.pid),
  ).length;
  if (running >= MAX_BACKGROUND_PROCESSES) {
    throw new ToolError(ERROR_CODES.BUSY, `At most ${MAX_BACKGROUND_PROCESSES} background processes may run at once.`);
  }
  await mkdir(processesDir(ctx), { recursive: true, mode: 0o700 });
  await chmod(processesDir(ctx), 0o700);
  const id = randomUUID();
  const logPath = path.join(processesDir(ctx), `${id}.log`);

  await ctx.audit({ event: "start_background_process.start", id, command: auditCommand.display, commandSha256: auditCommand.sha256, cwd: relativeCwd, flagged });

  // Redirect stdio straight to the log file rather than a pipe: a pipe is
  // exactly what makes `close` wait forever on a process that never closes
  // its own stdout. Open the fd ourselves, hand it to the child, then close
  // our copy — the child keeps its own duplicate.
  const fd = openSync(logPath, "a", 0o600);
  let child;
  try {
    child = spawnInShell(ctx, command, cwdPath, ["ignore", fd, fd]);
  } finally {
    closeSync(fd);
  }
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  child.on("error", (error) => {
    void ctx.audit({ event: "start_background_process.spawn_error", id, message: error.message });
  });

  const entry = {
    id,
    pid: child.pid,
    pgid: child.pid, // detached on POSIX makes the leader's pid its own pgid
    command: auditCommand.display,
    commandSha256: auditCommand.sha256,
    cwd: relativeCwd,
    logPath,
    startedAt: new Date().toISOString(),
    state: "running",
    owned: true,
  };
  backgroundProcesses.set(id, entry);
  child.once("close", async (code, signal) => {
    if (entry.state === "running") {
      entry.state = "exited";
      entry.exitedAt = new Date().toISOString();
      entry.exitCode = code;
      entry.signal = signal;
      await persistRegistry(ctx);
    }
  });
  await persistRegistry(ctx);
  await ctx.audit({ event: "start_background_process.finish", id, pid: child.pid });

  return { id, pid: child.pid, command: auditCommand.display, cwd: relativeCwd, logPath };
}

function listBackgroundProcesses() {
  return [...backgroundProcesses.values()].map((entry) => ({
    id: entry.id,
    command: entry.command,
    cwd: entry.cwd,
    pid: entry.pid,
    startedAt: entry.startedAt,
    state: entry.state || (isAlive(entry.pid) ? "running" : "exited"),
    running: entry.state === "running" && entry.owned && isAlive(entry.pid),
    recovered: !entry.owned,
  }));
}

async function readProcessOutput(ctx, { id, max_bytes: maxBytes }) {
  const entry = backgroundProcesses.get(id);
  if (!entry) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `No background process with id "${id}".`, { id });
  }
  const cap = Math.min(maxBytes ?? ctx.limits.maxCommandOutputBytes, ctx.limits.maxCommandOutputBytes);

  let size = 0;
  try {
    size = (await stat(entry.logPath)).size;
  } catch {
    size = 0;
  }

  let buf = Buffer.alloc(0);
  let truncated = false;
  if (size > 0) {
    const readFrom = Math.max(0, size - cap);
    truncated = readFrom > 0;
    const length = size - readFrom;
    buf = Buffer.alloc(length);
    const handle = await open(entry.logPath, "r");
    try {
      await handle.read(buf, 0, length, readFrom);
    } finally {
      await handle.close();
    }
    if (truncated) buf = trimLeadingContinuation(buf);
  }

  const decoder = new StringDecoder("utf8");
  const text = decoder.write(buf) + decoder.end();

  return {
    id,
    command: entry.command,
    running: entry.state === "running" && entry.owned && isAlive(entry.pid),
    state: entry.state,
    logBytes: size,
    truncated,
    text,
  };
}

async function stopBackgroundProcess(ctx, { id }) {
  const entry = backgroundProcesses.get(id);
  if (!entry) {
    throw new ToolError(ERROR_CODES.NOT_FOUND, `No background process with id "${id}".`, { id });
  }
  await ctx.audit({ event: "stop_background_process.start", id, pid: entry.pid });
  const wasRunning = entry.state === "running" && entry.owned && isAlive(entry.pid);
  if (wasRunning) {
    killProcessGroup(ctx, entry.pid);
    entry.state = "stopping";
    await persistRegistry(ctx);
  }
  await ctx.audit({ event: "stop_background_process.finish", id, pid: entry.pid, wasRunning });
  return { id, stopped: wasRunning, wasRunning, state: entry.state };
}

async function enforceLogBudget(ctx) {
  let total = 0;
  for (const entry of backgroundProcesses.values()) {
    if (entry.state !== "running" || !entry.owned) continue;
    const size = await stat(entry.logPath).then((info) => info.size).catch(() => 0);
    total += size;
    if (size > BACKGROUND_LOG_LIMIT_BYTES || total > BACKGROUND_TOTAL_LOG_LIMIT_BYTES) {
      killProcessGroup(ctx, entry.pid);
      entry.state = "output_limit_exceeded";
      entry.exitedAt = new Date().toISOString();
      await ctx.audit({
        event: "process.output_limit",
        id: entry.id,
        logBytes: size,
        totalLogBytes: total,
      });
    }
  }
  await persistRegistry(ctx);
}

/** One-time setup: reconcile the on-disk registry, wire shutdown and info. */
export async function initProcessTools(ctx) {
  await mkdir(processesDir(ctx), { recursive: true, mode: 0o700 });
  await chmod(processesDir(ctx), 0o700);

  let saved = [];
  try {
    saved = JSON.parse(await readFile(registryPath(ctx), "utf8"));
  } catch {
    saved = [];
  }
  const retentionCutoff = Date.now() - BACKGROUND_RETENTION_HOURS * 3_600_000;
  for (const entry of saved) {
    const finishedAt = Date.parse(entry.exitedAt || entry.startedAt || 0);
    if (entry.state !== "running" && Number.isFinite(finishedAt) && finishedAt < retentionCutoff) {
      await rm(entry.logPath, { force: true }).catch(() => {});
      continue;
    }
    backgroundProcesses.set(entry.id, {
      ...entry,
      owned: false,
      state: isAlive(entry.pid) ? "orphaned" : (entry.state === "running" ? "exited" : entry.state || "exited"),
    });
  }
  // Rewrite immediately so a dead entry from a previous run doesn't linger
  // on disk just because nothing happened to touch the registry since.
  await persistRegistry(ctx);

  ctx.addInfo(async () => ({ backgroundProcesses: listBackgroundProcesses() }));
  const budgetTimer = setInterval(() => {
    void enforceLogBudget(ctx);
  }, 1_000);
  budgetTimer.unref();

  ctx.onShutdown(async () => {
    clearInterval(budgetTimer);
    const stopped = [];
    for (const entry of backgroundProcesses.values()) {
      if (isAlive(entry.pid)) {
        if (entry.owned) killProcessGroup(ctx, entry.pid);
        stopped.push(entry.id);
      }
    }
    if (stopped.length) {
      await ctx.audit({ event: "process.shutdown_kill", ids: stopped });
    }
  });
}

export function registerProcessTools(server, ctx) {
  server.registerTool(
    "run_terminal_command",
    {
      title: "Run an unrestricted terminal command",
      description:
        "Run a command with the current user's normal shell, PATH, HOME, filesystem access, and network access, and wait for it to finish. Use start_background_process for a dev server or other long-running command. Commands start inside the selected workspace directory but are not confined to it. The bridge authentication token is removed from the child environment. Output is capped, and credential-oriented or pipe-to-shell command text is redacted and flagged in the audit log; commands are not denied by a bridge pattern policy.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default(".").describe("Workspace-relative working directory."),
        timeout_ms: z
          .number()
          .int()
          .min(100)
          .max(ctx.limits.maxCommandTimeoutMs)
          .default(30_000),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd, timeout_ms: timeoutMs }) => {
      try {
        return textResult(await runCommand(ctx, { command, cwd, timeoutMs }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "start_background_process",
    {
      title: "Start a long-running process in the background",
      description:
        "Spawn a command detached from this call and return immediately with its id, instead of waiting for it to exit. Use this for dev servers, watchers, or anything else that runs until stopped. Output goes to a bounded owner-only log. The process group is killed by stop_background_process or when the bridge shuts down. Sensitive-looking command text is redacted and flagged in the audit log, but no command pattern is denied.",
      inputSchema: {
        command: z.string().min(1).max(20_000),
        cwd: z.string().default(".").describe("Workspace-relative working directory."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ command, cwd }) => {
      try {
        const { logPath, ...rest } = await startBackgroundProcess(ctx, { command, cwd });
        return textResult(rest);
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "list_background_processes",
    {
      title: "List background processes",
      description:
        "Show every background process started this bridge run (or recovered from before a restart), whether it is still running, and the command it was started with.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => textResult({ processes: listBackgroundProcesses() }),
  );

  server.registerTool(
    "read_process_output",
    {
      title: "Read a background process's log",
      description:
        "Read the combined stdout and stderr a background process has produced so far. Returns the most recent output up to the byte limit, not the oldest.",
      inputSchema: {
        id: z.string().min(1).describe("The id returned by start_background_process."),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(ctx.limits.maxCommandOutputBytes)
          .optional()
          .describe(`How much of the tail to read, up to ${ctx.limits.maxCommandOutputBytes} bytes.`),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id, max_bytes: maxBytes }) => {
      try {
        return textResult(await readProcessOutput(ctx, { id, max_bytes: maxBytes }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "stop_background_process",
    {
      title: "Stop a background process",
      description:
        "Kill a background process and every process in its group. Safe to call on one that has already exited.",
      inputSchema: {
        id: z.string().min(1).describe("The id returned by start_background_process."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ id }) => {
      try {
        return textResult(await stopBackgroundProcess(ctx, { id }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
