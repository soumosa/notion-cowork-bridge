/**
 * The workspace boundary. Every file tool goes through here, and nothing in
 * this file follows a symbolic link or accepts a path it has not resolved
 * itself.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { CONTROL_ROOT, IS_WINDOWS, WORKSPACE_ROOT } from "./config.js";
import { ERROR_CODES, ToolError } from "./errors.js";

// Windows silently maps these names onto devices no matter which directory
// they appear in, so a write to "workspace/CON" never touches the workspace.
const WINDOWS_RESERVED_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
]);

export function isInside(root, candidate) {
  // Existing paths are additionally compared using realpath below. Do not
  // force-case macOS here: APFS volumes can legitimately be case-sensitive.
  const normalise = (value) => (IS_WINDOWS ? value.toLowerCase() : value);
  const base = normalise(root);
  const target = normalise(candidate);
  return target === base || target.startsWith(`${base}${path.sep}`);
}

/** The path an agent should see: relative to the workspace, never absolute. */
export function workspaceRelative(target) {
  return path.relative(WORKSPACE_ROOT, target);
}

/**
 * Reject the shapes that look relative but are not, before anything touches
 * the filesystem.
 *
 * The extra rules are Windows-only on purpose. On Linux a colon, a backslash
 * and a trailing dot are all ordinary filename characters, so applying NTFS
 * rules there would reject files that legitimately exist.
 */
export function assertPortableRelativePath(userPath) {
  if (typeof userPath !== "string" || userPath.includes("\0")) {
    throw new ToolError(
      ERROR_CODES.INVALID_PATH,
      "Path must be a text value without null bytes.",
    );
  }
  if (path.isAbsolute(userPath)) {
    throw new ToolError(
      ERROR_CODES.INVALID_PATH,
      "Use a workspace-relative path, not an absolute path.",
      { path: userPath },
    );
  }
  if (!IS_WINDOWS) return;

  if (/^[A-Za-z]:/.test(userPath)) {
    // "C:folder" is relative to the current directory *of drive C*, not to us.
    throw new ToolError(
      ERROR_CODES.INVALID_PATH,
      "Drive-relative paths such as C:folder are not allowed.",
      { path: userPath },
    );
  }
  if (userPath.includes(":")) {
    // Blocks NTFS alternate data streams (file.txt:hidden).
    throw new ToolError(
      ERROR_CODES.INVALID_PATH,
      "Colons are not allowed in workspace paths on Windows.",
      { path: userPath },
    );
  }

  for (const segment of userPath.split(/[\\/]/)) {
    if (segment === "" || segment === "." || segment === "..") continue;
    if (/[ .]$/.test(segment)) {
      // Windows silently trims these, so "notes." and "notes" collide.
      throw new ToolError(
        ERROR_CODES.INVALID_PATH,
        `Path segments must not end with a space or a dot: ${segment}`,
        { path: userPath },
      );
    }
    const stem = segment.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      throw new ToolError(
        ERROR_CODES.INVALID_PATH,
        `Reserved device name is not allowed: ${segment}`,
        { path: userPath },
      );
    }
  }
}

export function resolveWorkspacePath(userPath = ".") {
  assertPortableRelativePath(userPath);
  const resolved = path.resolve(WORKSPACE_ROOT, userPath || ".");
  if (!isInside(WORKSPACE_ROOT, resolved)) {
    throw new ToolError(
      ERROR_CODES.OUTSIDE_WORKSPACE,
      "Path escapes the configured workspace.",
      { path: userPath },
    );
  }
  return resolved;
}

export function assertWritableTarget(target) {
  if (isInside(CONTROL_ROOT, target)) {
    throw new ToolError(
      ERROR_CODES.PROTECTED_PATH,
      "The MCP bridge's own files are protected from modification.",
      { path: workspaceRelative(target) },
    );
  }
}

export async function assertNoSymlinkSegments(
  target,
  { allowMissingLeaf = false } = {},
) {
  const relative = workspaceRelative(target);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = WORKSPACE_ROOT;

  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (
        error?.code === "ENOENT" &&
        allowMissingLeaf &&
        index === segments.length - 1
      ) {
        return;
      }
      throw error;
    }
    // Node reports Windows junctions and other reparse points as symbolic
    // links, so this covers both families of redirect.
    if (info.isSymbolicLink()) {
      throw new ToolError(
        ERROR_CODES.IS_SYMLINK,
        `Symbolic links are not allowed: ${workspaceRelative(current)}`,
        { path: workspaceRelative(current) },
      );
    }
  }
}

export async function resolveExistingPath(userPath = ".") {
  const candidate = resolveWorkspacePath(userPath);
  await assertNoSymlinkSegments(candidate);
  const canonical = await realpath(candidate);
  const canonicalRoot = await realpath(WORKSPACE_ROOT);
  if (!isInside(canonicalRoot, canonical)) {
    throw new ToolError(
      ERROR_CODES.OUTSIDE_WORKSPACE,
      "Resolved path escapes the configured workspace.",
      { path: userPath },
    );
  }
  return canonical;
}
