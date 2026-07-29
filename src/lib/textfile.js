/**
 * Reading and writing a text file without corrupting it or the agent's
 * mental model of it: a byte-level line scanner, an atomic write that keeps
 * a file's mode, a sha256 precondition check, and the exact-string diff
 * engine behind edit_text_file.
 *
 * Pulled out of files.js on line-budget grounds; nothing here is specific
 * to that module's tool registrations, it is just the machinery underneath.
 */

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

import { ERROR_CODES, ToolError } from "./errors.js";

/**
 * Line-by-line scan of a file, stopping the moment we have everything a
 * requested range needs rather than loading the whole thing first. That is
 * what makes lines 1-50 of a 300 KB log reachable: the old code checked the
 * file's total size before it ever looked at start_line/end_line. The hard
 * byte cap now applies to what is returned, not to what is on disk.
 *
 * Also where BOM, CRLF-vs-LF and the phantom-trailing-line bug are handled,
 * because they all fall out of the same byte-level walk.
 */
export async function scanLines(target, from, stopAt, maxReturnBytes) {
  const handle = await open(target, "r");
  try {
    const CHUNK_SIZE = 64 * 1024;
    const readBuffer = Buffer.alloc(CHUNK_SIZE);
    let pending = Buffer.alloc(0);
    let position = 0;
    let lineNumber = 0;
    let crlfLines = 0;
    let lfLines = 0;
    let hasBOM = false;
    let firstChunk = true;
    let stoppedEarly = false;
    let returnedBytes = 0;
    const lines = [];

    const emit = (buffer, hadCRLF) => {
      lineNumber += 1;
      if (hadCRLF) crlfLines += 1;
      else lfLines += 1;
      if (lineNumber >= from && (stopAt === undefined || lineNumber <= stopAt)) {
        const text = buffer.toString("utf8");
        // The caller joins these with a newline, so N lines carry N-1
        // separators. Charging one for the last line too made a file of
        // exactly the limit fail when it had no trailing newline.
        returnedBytes += Buffer.byteLength(text, "utf8") + (lines.length > 0 ? 1 : 0);
        if (returnedBytes > maxReturnBytes) {
          throw new ToolError(
            ERROR_CODES.TOO_LARGE,
            `The requested line range exceeds the ${maxReturnBytes}-byte read limit. Narrow start_line/end_line.`,
          );
        }
        lines.push(text);
      }
    };

    readLoop: for (;;) {
      const { bytesRead } = await handle.read(readBuffer, 0, CHUNK_SIZE, position);
      position += bytesRead;
      if (bytesRead === 0) break;

      let chunk = readBuffer.subarray(0, bytesRead);
      if (firstChunk) {
        firstChunk = false;
        if (chunk.length >= 3 && chunk[0] === 0xef && chunk[1] === 0xbb && chunk[2] === 0xbf) {
          hasBOM = true;
          chunk = chunk.subarray(3);
        }
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : Buffer.from(chunk);
      if (pending.includes(0)) {
        throw new ToolError(ERROR_CODES.BINARY, "Binary files are not supported by read_text_file.");
      }

      let newlineAt;
      while ((newlineAt = pending.indexOf(0x0a)) !== -1) {
        let end = newlineAt;
        let hadCRLF = false;
        if (end > 0 && pending[end - 1] === 0x0d) {
          end -= 1;
          hadCRLF = true;
        }
        emit(pending.subarray(0, end), hadCRLF);
        pending = pending.subarray(newlineAt + 1);
        if (stopAt !== undefined && lineNumber >= stopAt) {
          stoppedEarly = true;
          break readLoop;
        }
      }
    }

    let hasTrailingNewline = false;
    if (!stoppedEarly) {
      if (pending.length > 0) {
        emit(pending, false);
      } else {
        hasTrailingNewline = lineNumber > 0;
      }
    }

    return {
      lines,
      lastLine: lineNumber,
      totalLines: stoppedEarly ? null : lineNumber,
      lineEnding: crlfLines > lfLines ? "CRLF" : "LF",
      hasTrailingNewline,
      hasBOM,
    };
  } finally {
    await handle.close();
  }
}

/**
 * The write itself: temp file, fsync it, rename over the target. Shared by
 * write_text_file and edit_text_file so the mode/durability fix lives once.
 *
 * The bug this closes: a rename replaces the inode outright, so a temp file
 * created 0600 and renamed over an existing 0755 script silently strips its
 * executable bit on every save. We stat the target first and carry its mode
 * onto the temp file's handle before the rename ever happens.
 *
 * Takes `paths` - the two `ctx.paths` functions it actually needs - rather
 * than the whole `ctx`. Importing `lib/paths.js` directly here would also
 * pull in `lib/config.js`, which reads the real environment (MCP_AUTH_TOKEN
 * and friends) as a side effect of being imported at all; a lib module with
 * no tool-specific job has no business acquiring that dependency.
 */
export async function atomicWriteWorkspaceFile(paths, target, content) {
  const parent = path.dirname(target);
  await paths.assertNoSymlinkSegments(parent);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) {
    throw new ToolError(ERROR_CODES.NOT_A_DIRECTORY, "The parent path is not a directory.", {
      path: paths.workspaceRelative(parent),
    });
  }
  await paths.assertNoSymlinkSegments(target, { allowMissingLeaf: true });

  let existingMode = null;
  try {
    existingMode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const temporary = path.join(
    parent,
    `.notion-mcp-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(
    temporary,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(content, "utf8");
    if (existingMode !== null) await handle.chmod(existingMode);
    await handle.sync();
  } finally {
    await handle.close();
  }

  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }

  // Best effort: not every platform lets you open a directory for fsync.
  // When it fails the file itself is still durable; only the directory
  // entry might lag a moment behind a crash.
  try {
    const dirHandle = await open(parent, "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  } catch {
    /* best effort */
  }

  return {
    bytesWritten: Buffer.byteLength(content, "utf8"),
    sha256: createHash("sha256").update(content, "utf8").digest("hex"),
  };
}

/** Binary counterpart of atomicWriteWorkspaceFile for screenshots and uploads. */
export async function atomicWriteWorkspaceBytes(paths, target, content) {
  const parent = path.dirname(target);
  await paths.assertNoSymlinkSegments(parent);
  const parentInfo = await stat(parent);
  if (!parentInfo.isDirectory()) {
    throw new ToolError(ERROR_CODES.NOT_A_DIRECTORY, "The parent path is not a directory.");
  }
  await paths.assertNoSymlinkSegments(target, { allowMissingLeaf: true });
  let existingMode = null;
  try {
    existingMode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const temporary = path.join(
    parent,
    `.notion-mcp-write-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  const handle = await open(temporary, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    await handle.writeFile(content);
    if (existingMode !== null) await handle.chmod(existingMode);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return {
    bytesWritten: content.length,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

export async function assertMatchesSha256(target, relativePath, expected) {
  let actual;
  try {
    actual = createHash("sha256").update(await readFile(target)).digest("hex");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new ToolError(
        ERROR_CODES.PRECONDITION_FAILED,
        "if_sha256 was given but the file does not exist yet.",
        { path: relativePath },
      );
    }
    throw error;
  }
  if (actual !== expected) {
    throw new ToolError(
      ERROR_CODES.PRECONDITION_FAILED,
      "The file has changed since if_sha256 was read. Re-read it and try again.",
      { path: relativePath, expected, actual },
    );
  }
}

function countOccurrences(text, needle) {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

const DIFF_CONTEXT_LINES = 3;

/**
 * A unified diff hunk for one exact-string replacement. We already know
 * precisely what changed and where an edit lands, so there is no reason to
 * run a general line-diff algorithm over the whole file - that would be
 * slower on a large file and would tell the agent nothing an LLM couldn't
 * already infer from the substitution itself.
 */
function buildDiffHunk(text, matchIndex, oldString, newString) {
  const before = text.slice(0, matchIndex);
  const after = text.slice(matchIndex + oldString.length);
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const oldTouched = oldString.split("\n");
  const newTouched = newString.split("\n");

  // The partial line on each side of the match belongs to the touched
  // region, not to context - stitch it back onto the first/last line.
  const lead = beforeLines[beforeLines.length - 1];
  const trail = afterLines[0];
  oldTouched[0] = lead + oldTouched[0];
  oldTouched[oldTouched.length - 1] += trail;
  newTouched[0] = lead + newTouched[0];
  newTouched[newTouched.length - 1] += trail;

  const contextBefore = beforeLines.slice(0, -1).slice(-DIFF_CONTEXT_LINES);
  const contextAfter = afterLines.slice(1, 1 + DIFF_CONTEXT_LINES);

  const matchStartLine = beforeLines.length; // 1-based line the match begins on
  const oldStart = matchStartLine - contextBefore.length;
  const oldCount = contextBefore.length + oldTouched.length + contextAfter.length;
  const newCount = contextBefore.length + newTouched.length + contextAfter.length;

  return [
    `@@ -${oldStart},${oldCount} +${oldStart},${newCount} @@`,
    ...contextBefore.map((line) => ` ${line}`),
    ...oldTouched.map((line) => `-${line}`),
    ...newTouched.map((line) => `+${line}`),
    ...contextAfter.map((line) => ` ${line}`),
  ].join("\n");
}

/**
 * Applies every edit against an in-memory copy of the text and only returns
 * once all of them have succeeded. Nothing touches disk in here, which is
 * what makes the whole call atomic: an edit that fails halfway through just
 * throws, and the file is exactly as it was before the call started.
 */
export function applyEdits(originalText, edits) {
  let working = originalText;
  const hunks = [];

  edits.forEach((edit, editIndex) => {
    const { old_string: oldString, new_string: newString, expected_occurrences: expected } = edit;
    const occurrences = countOccurrences(working, oldString);
    if (occurrences === 0) {
      throw new ToolError(
        ERROR_CODES.NOT_FOUND,
        `Edit ${editIndex}: old_string was not found in the file.`,
        { editIndex },
      );
    }
    if (expected !== undefined) {
      if (occurrences !== expected) {
        throw new ToolError(
          ERROR_CODES.CONFLICT,
          `Edit ${editIndex}: old_string occurs ${occurrences} time(s), expected ${expected}.`,
          { editIndex, occurrences, expected },
        );
      }
    } else if (occurrences > 1) {
      throw new ToolError(
        ERROR_CODES.CONFLICT,
        `Edit ${editIndex}: old_string is ambiguous - it occurs ${occurrences} times. Add context to make it unique, or set expected_occurrences.`,
        { editIndex, occurrences },
      );
    }

    let searchFrom = 0;
    for (let i = 0; i < occurrences; i += 1) {
      const index = working.indexOf(oldString, searchFrom);
      hunks.push(buildDiffHunk(working, index, oldString, newString));
      working = working.slice(0, index) + newString + working.slice(index + oldString.length);
      searchFrom = index + newString.length;
    }
  });

  return { text: working, diff: hunks.join("\n") };
}
