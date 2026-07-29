/**
 * The flight recorder: one JSON line per consequential action.
 *
 * THE ORDERING INVARIANT. Every consequential tool writes a `<tool>.start`
 * record BEFORE it acts and a `<tool>.finish` record after it is done. That
 * ordering is the single most important rule in this codebase: a command that
 * hangs, a process that is SIGKILLed, and a machine that loses power all leave
 * the start record behind, so "what did the agent do" is answerable even when
 * nothing came back. A tool that logs only on success is a tool whose worst
 * moments are invisible. Never reorder these two calls to save a write.
 *
 * A failure to write the log is reported but never blocks the caller, because
 * a broken log should not brick the bridge.
 *
 * Each record carries `prevHash`, the SHA-256 of the previous line including
 * its trailing newline. The log is still editable by anything running as you —
 * that is honest in SECURITY.md — but editing it now breaks the chain from the
 * altered line onwards, so tampering becomes detectable. To verify: hash line
 * N and compare with line N+1's `prevHash`. The chain continues across
 * rotation, so verification walks the rotated files oldest-first.
 *
 * Every record is also mirrored to the operating system's log, which a
 * user-level process can append to but cannot rewrite in place. Mirroring is
 * best effort by design: it never blocks and it never throws.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import {
  AUDIT_KEEP_FILES,
  AUDIT_MAX_BYTES,
  AUDIT_PATH,
  childEnvironment,
  IS_MACOS,
  IS_WINDOWS,
} from "./config.js";

const LOG_TAG = "notion-cowork-bridge";
// Enough tail to hold the longest line the bridge writes (a command is capped
// at 20,000 characters) with room to spare.
const TAIL_BYTES = 256 * 1024;

let previousLineHash = null;
let chainSeeded = false;
let directoryReady = false;
// Writes are serialised: two concurrent requests must not read the same
// previous hash and produce two records claiming the same predecessor.
let pending = Promise.resolve();
const mirrorQueue = [];
let mirrorTimer = null;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Continue the chain from whatever is already on disk after a restart. */
async function seedChain() {
  chainSeeded = true;
  try {
    const info = await stat(AUDIT_PATH);
    if (info.size === 0) return;
    const length = Math.min(info.size, TAIL_BYTES);
    const handle = await open(AUDIT_PATH, "r");
    try {
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, info.size - length);
      // The first line in the window may be a fragment; the last complete one
      // is what the next record chains from.
      const lines = buffer.toString("utf8").split("\n").filter(Boolean);
      const last = lines.at(-1);
      if (last) previousLineHash = sha256(`${last}\n`);
    } finally {
      await handle.close();
    }
  } catch {
    // No log yet, or an unreadable one. Start a fresh chain.
    previousLineHash = null;
  }
}

async function renameIfPresent(from, to) {
  try {
    await rename(from, to);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function rotateIfNeeded(nextLineBytes) {
  const info = await stat(AUDIT_PATH).catch(() => null);
  if (!info || info.size + nextLineBytes <= AUDIT_MAX_BYTES) return;

  await rm(`${AUDIT_PATH}.${AUDIT_KEEP_FILES}`, { force: true });
  for (let index = AUDIT_KEEP_FILES - 1; index >= 1; index -= 1) {
    await renameIfPresent(`${AUDIT_PATH}.${index}`, `${AUDIT_PATH}.${index + 1}`);
  }
  await renameIfPresent(AUDIT_PATH, `${AUDIT_PATH}.1`);
}

function spawnDetached(command, args) {
  const child = spawn(command, args, {
    stdio: "ignore",
    detached: true,
    windowsHide: true,
    env: childEnvironment(),
  });
  // The tool may not exist on this machine; there is nothing to do about it.
  child.on("error", () => {});
  child.unref();
}

function flushMirror() {
  mirrorTimer = null;
  const summary = mirrorQueue.shift();
  if (!summary) return;
  try {
    if (IS_MACOS) spawnDetached("logger", ["-t", LOG_TAG, summary]);
    else if (IS_WINDOWS) {
      spawnDetached("eventcreate", ["/T", "INFORMATION", "/ID", "1", "/L", "APPLICATION", "/SO", LOG_TAG, "/D", summary]);
    } else process.stderr.write(`${LOG_TAG} ${summary}\n`);
  } catch {
    /* mirroring is best effort */
  }
  if (mirrorQueue.length) mirrorTimer = setTimeout(flushMirror, 1_000);
}

function mirrorToSystemLog(line) {
  try {
    const { time, event, prevHash } = JSON.parse(line);
    if (mirrorQueue.length >= 100) mirrorQueue.shift();
    mirrorQueue.push(JSON.stringify({ time, event, prevHash }));
    if (!mirrorTimer) mirrorTimer = setTimeout(flushMirror, 0);
  } catch {
    /* mirroring is best effort */
  }
}

async function append(line) {
  if (!directoryReady) {
    await mkdir(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    directoryReady = true;
  }
  await appendFile(AUDIT_PATH, line, { mode: 0o600 });
  await chmod(AUDIT_PATH, 0o600);
}

async function writeRecord(record) {
  if (!chainSeeded) await seedChain();

  const line = `${JSON.stringify({
    time: new Date().toISOString(),
    ...record,
    prevHash: previousLineHash,
  })}\n`;

  try {
    await rotateIfNeeded(Buffer.byteLength(line, "utf8"));
    try {
      await append(line);
    } catch {
      // The state directory can be removed underneath a long-running bridge,
      // so never trust the cached flag after a failure.
      directoryReady = false;
      await append(line);
    }
    // Only advance the chain once the line is actually on disk.
    previousLineHash = sha256(line);
  } catch (error) {
    console.error(`Audit write failed: ${error.message}`);
  }

  mirrorToSystemLog(line);
}

/** Append one JSON line per consequential action. Never throws. */
export function audit(record) {
  pending = pending.then(() => writeRecord(record));
  return pending;
}
