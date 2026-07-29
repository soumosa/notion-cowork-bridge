/**
 * Pure-function tests for the workspace boundary. `assertPortableRelativePath`
 * and `isInside` are the two checks every path a tool touches has to pass,
 * and until now they were only reachable through a live HTTP request. Import
 * them directly so a whole traversal corpus runs in milliseconds instead of
 * one round trip per shape.
 *
 * `src/lib/config.js` throws at import time if MCP_AUTH_TOKEN is short, so
 * the environment has to be set before the module graph loads. A static
 * `import` is hoisted above any code in this file, so the token is set and
 * the module is pulled in with a dynamic `import()` instead, which runs in
 * source order.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";

process.env.MCP_AUTH_TOKEN = "unit-test-token-0123456789-0123456789";

const IS_WINDOWS = process.platform === "win32";

function windowsOnly(reason = "Windows-only path rules.") {
  return IS_WINDOWS ? false : reason;
}
function posixOnly(reason = "POSIX-only: this path shape is a legal filename there.") {
  return IS_WINDOWS ? reason : false;
}

const { assertPortableRelativePath, isInside } = await import(
  "../../src/lib/paths.js"
);

function rejects(userPath, pattern) {
  assert.throws(
    () => assertPortableRelativePath(userPath),
    (error) => {
      assert.equal(error.name, "ToolError");
      if (pattern) assert.match(error.message, pattern);
      return true;
    },
  );
}

function accepts(userPath) {
  assert.doesNotThrow(() => assertPortableRelativePath(userPath));
}

// ---------------------------------------------------------------------------
// assertPortableRelativePath
// ---------------------------------------------------------------------------

test("accepts ordinary relative paths", () => {
  for (const value of [
    "notes.txt",
    "a/b/c.txt",
    "./notes.txt",
    "sub/dir/",
    ".hidden",
    "..", // relative-looking; escaping the root is isInside's job, not this one
    "../sibling",
    "a/../../b",
    "./././..",
    "foo/./../../bar",
  ]) {
    accepts(value);
  }
});

test("accepts the empty string and a bare dot", () => {
  // Both mean "the workspace root itself" one layer up, in resolveWorkspacePath.
  accepts("");
  accepts(".");
});

test("accepts trailing slashes", () => {
  accepts("notes/");
  accepts("a/b/");
});

test("rejects a path containing a null byte, anywhere in it", () => {
  rejects("foo\0bar", /null bytes/i);
  rejects("\0", /null bytes/i);
  rejects("a/\0/b", /null bytes/i);
  rejects("trailing\0", /null bytes/i);
});

test("rejects non-string input", () => {
  for (const value of [null, undefined, 42, true, {}, [], Symbol("x")]) {
    rejects(value, /text value/i);
  }
});

test("rejects absolute POSIX-style paths", () => {
  // path.isAbsolute treats a leading "/" as absolute on every platform Node
  // runs the bridge on, including Windows (root of the current drive there).
  rejects("/etc/passwd", /absolute/i);
  rejects("/", /absolute/i);
  rejects("//etc/passwd", /absolute/i);
});

test("rejects a Windows drive-absolute path", { skip: windowsOnly("Only path.win32.isAbsolute treats this as absolute.") }, () => {
  assert.equal(path.isAbsolute("C:\\Windows\\System32"), true);
  rejects("C:\\Windows\\System32", /absolute/i);
});

test(
  "rejects Windows drive-relative paths (C:folder)",
  { skip: windowsOnly() },
  () => {
    rejects("C:folder", /drive-relative/i);
    rejects("c:folder/sub.txt", /drive-relative/i);
  },
);

test(
  "rejects colons anywhere on Windows (NTFS alternate data streams)",
  { skip: windowsOnly() },
  () => {
    rejects("notes.txt:hidden", /colons are not allowed/i);
    rejects("a/b:c", /colons are not allowed/i);
  },
);

test(
  "allows colons on POSIX, where they are an ordinary filename character",
  { skip: posixOnly("This is exactly the Windows-only rule under test.") },
  () => {
    accepts("notes.txt:hidden");
    accepts("2024-01-01T00:00:00.txt");
  },
);

test(
  "rejects segments ending in a space or a dot on Windows",
  { skip: windowsOnly() },
  () => {
    rejects("notes. ", /space or a dot/i);
    rejects("notes.", /space or a dot/i);
    rejects("a/trailing. /b", /space or a dot/i);
  },
);

test(
  "allows trailing dots and spaces on POSIX, where they are ordinary characters",
  { skip: posixOnly("This is exactly the Windows-only rule under test.") },
  () => {
    accepts("notes.");
    accepts("notes. ");
  },
);

test(
  "rejects Windows reserved device names, case-insensitively, with or without an extension",
  { skip: windowsOnly() },
  () => {
    for (const name of ["CON", "con", "Con", "PRN", "AUX", "NUL", "COM1", "com9", "LPT1", "lpt9"]) {
      rejects(name, /reserved device name/i);
      rejects(`${name}.txt`, /reserved device name/i);
    }
    rejects("dir/CON", /reserved device name/i);
  },
);

test(
  "does not reject names that merely start with a reserved word",
  { skip: windowsOnly() },
  () => {
    // CONSOLE.txt's stem is CONSOLE, not CON - the check splits on "." for the
    // stem, not a prefix match.
    accepts("CONSOLE.txt");
    accepts("comet.txt");
    accepts("lpt99.txt"); // only LPT1-9 are reserved
    accepts("com10.txt"); // only COM1-9 are reserved
  },
);

test("backslashes are an ordinary filename character on POSIX", { skip: posixOnly("This is exactly the Windows-only rule under test.") }, () => {
  accepts("weird\\name.txt");
});

// ---------------------------------------------------------------------------
// isInside - the traversal corpus. assertPortableRelativePath does not reject
// ".." shapes on its own (they are ordinary relative-path syntax); the escape
// is only visible once the path is resolved against a root and checked here.
// ---------------------------------------------------------------------------

const ROOT = path.join(path.sep, "workspace", "root");

function resolvedInside(userPath) {
  assert.doesNotThrow(() => assertPortableRelativePath(userPath));
  const resolved = path.resolve(ROOT, userPath);
  return isInside(ROOT, resolved);
}

test("isInside: the root resolves inside itself", () => {
  assert.equal(isInside(ROOT, ROOT), true);
  assert.equal(resolvedInside("."), true);
  assert.equal(resolvedInside(""), true);
});

test("isInside: an ordinary nested path stays inside", () => {
  assert.equal(resolvedInside("a/b/c.txt"), true);
  assert.equal(resolvedInside("notes/"), true);
});

test("isInside: single- and double-dot traversal that nets non-negative stays inside", () => {
  assert.equal(resolvedInside("a/../b"), true); // nets to "b"
  assert.equal(resolvedInside("./a/./b"), true);
  assert.equal(resolvedInside("a/./../a/b"), true);
});

test("isInside: traversal that nets negative escapes", () => {
  assert.equal(resolvedInside(".."), false);
  assert.equal(resolvedInside("../sibling"), false);
  assert.equal(resolvedInside("a/../../b"), false); // one level up nets outside
  assert.equal(resolvedInside("./././.."), false);
  assert.equal(resolvedInside("foo/./../../bar"), false);
  assert.equal(resolvedInside("a/b/../../../c"), false);
});

test("isInside: percent-encoded traversal is not decoded, so it stays a literal (harmless) filename", () => {
  // "..%2f" has no real path separator in it - path.resolve treats the whole
  // thing as one segment name, not as "../". This is the point: the bridge
  // must never URL-decode a path before checking it.
  assert.equal(resolvedInside("..%2f"), true);
  assert.equal(resolvedInside("..%2f..%2f..%2fetc%2fpasswd"), true);
  assert.equal(resolvedInside("%2e%2e/%2e%2e/secret"), true); // still literal segments
});

test("isInside: a case-flipped prefix is not an escape (no accidental startsWith match)", () => {
  // "/workspace/root-evil" shares a string prefix with the root but is a
  // sibling directory, not something inside it. isInside must require the
  // path separator right after the root, not just a prefix match.
  assert.equal(isInside(ROOT, `${ROOT}-evil`), false);
  assert.equal(isInside(ROOT, `${ROOT}-evil/secret`), false);
  assert.equal(isInside(ROOT, path.join(`${ROOT}-evil`, "secret")), false);
});

test(
  "isInside: Windows path comparison is case-insensitive",
  { skip: windowsOnly() },
  () => {
    const upper = ROOT.toUpperCase();
    assert.equal(isInside(ROOT, path.join(upper, "file.txt")), true);
    assert.equal(isInside(upper, path.join(ROOT, "file.txt")), true);
  },
);

test(
  "isInside: POSIX path comparison is case-sensitive",
  { skip: posixOnly("This is exactly the Windows-only behaviour under test.") },
  () => {
    const upper = ROOT.toUpperCase();
    assert.notEqual(upper, ROOT);
    assert.equal(isInside(ROOT, path.join(upper, "file.txt")), false);
  },
);

test("isInside: NFC and NFD forms of the same visible name are distinct byte sequences, not merged", () => {
  const nfc = "café.txt"; // U+00E9, LATIN SMALL LETTER E WITH ACUTE
  const nfd = "cafe\u0301.txt"; // "e" + U+0301 COMBINING ACUTE ACCENT
  assert.notEqual(nfc, nfd);
  assert.notEqual(nfc.normalize("NFC"), nfd); // confirms the two literals really do differ
  // Neither form gets special treatment: both are ordinary filenames that
  // resolve inside the root, and they are treated as two different files
  // (the module does no Unicode normalisation of its own).
  assert.equal(resolvedInside(nfc), true);
  assert.equal(resolvedInside(nfd), true);
  const resolvedNfc = path.resolve(ROOT, nfc);
  const resolvedNfd = path.resolve(ROOT, nfd);
  assert.notEqual(resolvedNfc, resolvedNfd);
});

test("isInside: a \\\\?\\ device-path prefix", () => {
  const input = "\\\\?\\C:\\Windows\\System32\\config\\SAM";
  if (IS_WINDOWS) {
    // path.win32.isAbsolute treats a leading "\\\\" as a UNC root, so this is
    // rejected as absolute before isInside is ever reached.
    assert.equal(path.isAbsolute(input), true);
    rejects(input, /absolute/i);
  } else {
    // On POSIX a backslash is just a character, so the whole string is one
    // literal (and harmless) filename inside the root.
    assert.equal(resolvedInside(input), true);
  }
});

test("isInside: a very long path is handled by string comparison alone", () => {
  const longSegment = "a".repeat(4000);
  const longPath = `deep/${longSegment}/${longSegment}/file.txt`;
  assert.equal(resolvedInside(longPath), true);
  // 300 nested single-character directories, still just string comparison.
  const manySegments = Array.from({ length: 300 }, (_, i) => `d${i}`).join("/");
  assert.equal(resolvedInside(manySegments), true);
});

test("isInside: an escape padded out to a long path still escapes", () => {
  const longSegment = "a".repeat(4000);
  assert.equal(resolvedInside(`${longSegment}/../../../../etc/passwd`), false);
});
