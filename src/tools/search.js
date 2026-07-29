/**
 * Finding things without reaching for the shell.
 *
 * grep and find both work fine from run_terminal_command, but every routine
 * lookup that goes through it burns an approval prompt on the one tool that
 * is genuinely unrestricted. These two do the same job workspace-scoped, so
 * an agent reading a codebase almost never needs the shell just to look
 * around - which is a security win as much as a convenience one: every
 * search this serves is one fewer run_terminal_command call an injected
 * prompt could try to hide something inside.
 *
 * Split out of files.js purely on line-budget grounds; it reuses the
 * ignore-list and glob helpers in `../lib/globs.js` rather than
 * reimplementing them.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { Worker } from "node:worker_threads";
import * as z from "zod/v4";

import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";
import {
  DEFAULT_IGNORE_NAMES,
  createIgnoreMatcher,
  globToRegExp,
} from "../lib/globs.js";
import { MAX_SEARCH_PATTERN_BYTES, SEARCH_TIMEOUT_MS } from "../lib/config.js";

const DEFAULT_MAX_RESULTS = 200;
const MAX_MAX_RESULTS = 2000;
const MAX_CONTEXT_LINES = 20;
const MAX_FILES_SCANNED = 5000;
// Files bigger than this are skipped rather than read whole into memory;
// search is for source trees, not for grepping multi-megabyte logs.
const MAX_FILE_SIZE_FOR_SEARCH = 4 * 1024 * 1024;

function findMatchingLines(pattern, lines, timeoutMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./search-worker.js", import.meta.url));
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new ToolError(ERROR_CODES.SEARCH_TIMEOUT, "Search pattern exceeded the 10-second evaluation limit."));
    }, timeoutMs);
    worker.once("message", (result) => {
      clearTimeout(timer);
      void worker.terminate();
      if (result.error) reject(new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Not a valid pattern: " + result.error));
      else resolve(result.matches);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      void worker.terminate();
      reject(error);
    });
    worker.postMessage({ pattern, lines });
  });
}

/** Walk the tree once, honouring the same ignore list list_files uses. */
async function collectFiles(ctx, root, glob, shouldIgnore) {
  const files = [];
  const globRegExp = glob ? globToRegExp(glob) : null;

  async function walk(directory) {
    if (files.length >= MAX_FILES_SCANNED) return;
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (files.length >= MAX_FILES_SCANNED) return;
      const fullPath = path.join(directory, child.name);
      const relativePath = ctx.paths.workspaceRelative(fullPath);
      if (await shouldIgnore(relativePath, child.isDirectory())) continue;
      if (child.isSymbolicLink()) continue; // never follow, same rule as everywhere else
      if (child.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!child.isFile()) continue;
      if (globRegExp && !globRegExp.test(relativePath) && !globRegExp.test(child.name)) continue;
      files.push({ fullPath, relativePath });
    }
  }

  await walk(root);
  return files;
}

async function searchText(ctx, { pattern, path: userPath, glob, max_results: maxResults, context_lines: contextLines }) {
  if (Buffer.byteLength(pattern, "utf8") > MAX_SEARCH_PATTERN_BYTES) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Search pattern exceeds the 1,000-byte limit.");
  }
  try {
    new RegExp(pattern, "g");
  } catch (error) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, `Not a valid pattern: ${error.message}`, {
      pattern,
    });
  }

  const root = await ctx.paths.resolveExistingPath(userPath);
  const files = await collectFiles(ctx, root, glob, await createIgnoreMatcher(ctx.workspaceRoot, DEFAULT_IGNORE_NAMES));

  const matches = [];
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  let filesScanned = 0;
  let truncated = files.length >= MAX_FILES_SCANNED;

  outer: for (const file of files) {
    let info;
    try {
      info = await stat(file.fullPath);
    } catch {
      continue;
    }
    if (!info.isFile() || info.size > MAX_FILE_SIZE_FOR_SEARCH) continue;

    let buffer;
    try {
      buffer = await readFile(file.fullPath);
    } catch {
      continue;
    }
    if (buffer.includes(0)) continue; // binary; skip it quietly, same as list_files does for type
    filesScanned += 1;

    const lines = buffer.toString("utf8").split(/\r?\n/);
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ToolError(ERROR_CODES.SEARCH_TIMEOUT, "Search exceeded the 10-second evaluation limit.");
    }
    const matchingLines = await findMatchingLines(pattern, lines, remaining);
    for (const lineIndex of matchingLines) {
      if (matches.length >= maxResults) {
        truncated = true;
        break outer;
      }
      matches.push({
        file: file.relativePath,
        line: lineIndex + 1,
        text: lines[lineIndex],
        before:
          contextLines > 0 ? lines.slice(Math.max(0, lineIndex - contextLines), lineIndex) : undefined,
        after:
          contextLines > 0 ? lines.slice(lineIndex + 1, lineIndex + 1 + contextLines) : undefined,
      });
    }
  }

  return {
    pattern,
    path: ctx.paths.workspaceRelative(root) || ".",
    glob: glob ?? null,
    filesScanned,
    matches,
    truncated,
  };
}

async function globFiles(ctx, { pattern, path: userPath, max_results: maxResults }) {
  const root = await ctx.paths.resolveExistingPath(userPath);
  const files = await collectFiles(ctx, root, pattern, await createIgnoreMatcher(ctx.workspaceRoot, DEFAULT_IGNORE_NAMES));
  const truncated = files.length > maxResults;
  return {
    pattern,
    path: ctx.paths.workspaceRelative(root) || ".",
    matches: files.slice(0, maxResults).map((file) => file.relativePath),
    truncated,
  };
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

export function registerSearchTools(server, ctx) {
  server.registerTool(
    "search_text",
    {
      title: "Search file contents in the workspace",
      description:
        "Search workspace text files for a regular expression, line by line, without shelling out to grep. Skips .git, node_modules, dist, build, target, .venv, __pycache__, .bridge-trash and anything the workspace's .gitignore excludes, plus any binary file it meets along the way. Results are capped; check the truncated flag.",
      inputSchema: {
        pattern: z.string().min(1).describe("A JavaScript regular expression, matched per line."),
        path: z.string().default(".").describe("Workspace-relative directory to search under."),
        glob: z.string().optional().describe("Only search files whose path matches this glob."),
        max_results: z.number().int().min(1).max(MAX_MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
        context_lines: z.number().int().min(0).max(MAX_CONTEXT_LINES).default(0),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        return textResult(await searchText(ctx, args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "glob_files",
    {
      title: "Find workspace files by name",
      description:
        "List workspace files whose path matches a glob (supports *, ** and ?) without shelling out to find. Honours the same ignore list as list_files and search_text.",
      inputSchema: {
        pattern: z.string().min(1).describe("Glob to match against each file's workspace-relative path."),
        path: z.string().default(".").describe("Workspace-relative directory to search under."),
        max_results: z.number().int().min(1).max(MAX_MAX_RESULTS).default(DEFAULT_MAX_RESULTS),
      },
      annotations: READ_ONLY,
    },
    async (args) => {
      try {
        return textResult(await globFiles(ctx, args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
