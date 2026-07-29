/**
 * Pure-function tests for `shellArguments`: turning one command string into
 * the argv a given shell wants, which was previously only exercised
 * indirectly by whichever shell happens to be installed on the machine
 * running the suite. See paths.test.js for why the token is set before a
 * dynamic import rather than a static one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MCP_AUTH_TOKEN = "unit-test-token-0123456789-0123456789";

const IS_WINDOWS = process.platform === "win32";

const { shellArguments } = await import("../../src/lib/config.js");

test("bash and zsh get -lc with the command untouched", () => {
  assert.deepEqual(shellArguments("/bin/bash", "echo hi"), ["-lc", "echo hi"]);
  assert.deepEqual(shellArguments("/bin/zsh", "echo hi"), ["-lc", "echo hi"]);
  assert.deepEqual(shellArguments("/usr/bin/zsh", "echo hi"), ["-lc", "echo hi"]);
});

test("an unrecognised POSIX shell falls back to -lc", () => {
  assert.deepEqual(shellArguments("/usr/local/bin/fish", "echo hi"), ["-lc", "echo hi"]);
  assert.deepEqual(shellArguments("dash", "echo hi"), ["-lc", "echo hi"]);
});

test("cmd.exe gets /d /s /c, matched case-insensitively and by basename", () => {
  const expected = ["/d", "/s", "/c", "dir"];
  assert.deepEqual(shellArguments("cmd.exe", "dir"), expected);
  assert.deepEqual(shellArguments("CMD.EXE", "dir"), expected);
  assert.deepEqual(shellArguments("Cmd.Exe", "dir"), expected);
  // No .exe suffix at all - still matched by basename alone.
  assert.deepEqual(shellArguments("cmd", "dir"), expected);
});

test(
  "cmd.exe is still matched when given as a full backslash path",
  { skip: IS_WINDOWS ? false : "path.basename only treats \\ as a separator on Windows." },
  () => {
    assert.deepEqual(shellArguments("C:\\Windows\\System32\\cmd.exe", "dir"), [
      "/d",
      "/s",
      "/c",
      "dir",
    ]);
  },
);

test("powershell.exe and pwsh both get -NoProfile -NonInteractive -Command", () => {
  const expected = (command) => ["-NoProfile", "-NonInteractive", "-Command", command];
  assert.deepEqual(shellArguments("powershell.exe", "Get-ChildItem"), expected("Get-ChildItem"));
  assert.deepEqual(shellArguments("POWERSHELL.EXE", "Get-ChildItem"), expected("Get-ChildItem"));
  assert.deepEqual(shellArguments("pwsh", "Get-ChildItem"), expected("Get-ChildItem"));
  assert.deepEqual(shellArguments("pwsh.exe", "Get-ChildItem"), expected("Get-ChildItem"));
  assert.deepEqual(
    shellArguments("/usr/local/bin/pwsh", "Get-ChildItem"),
    expected("Get-ChildItem"),
  );
});

test(
  "pwsh is still matched when given as a full backslash path with spaces",
  { skip: IS_WINDOWS ? false : "path.basename only treats \\ as a separator on Windows." },
  () => {
    assert.deepEqual(
      shellArguments("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "Get-ChildItem"),
      ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem"],
    );
  },
);

test("the command string is passed through verbatim, quoting and all", () => {
  const command = "echo 'a b' \"c\" && rm -rf ./tmp; echo $?  # comment\nline two";
  assert.deepEqual(shellArguments("/bin/bash", command), ["-lc", command]);
  assert.deepEqual(shellArguments("cmd.exe", command), ["/d", "/s", "/c", command]);
  assert.deepEqual(shellArguments("pwsh", command), [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    command,
  ]);
});

test("an empty command is still passed through, not dropped", () => {
  assert.deepEqual(shellArguments("/bin/bash", ""), ["-lc", ""]);
});
