import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const IS_WINDOWS = process.platform === "win32";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = "test-install.ngrok-free.dev";
const PORT = "33297";

function skipReason() {
  return IS_WINDOWS ? false : "This installer is Windows-only.";
}

let tempRoot;
let argvLog;
let result;
let config;

function pwshAvailable() {
  const probe = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], {
    stdio: "ignore",
  });
  return !probe.error && probe.status === 0;
}

before(() => {
  if (!IS_WINDOWS) return;

  tempRoot = mkdtempSync(path.join(tmpdir(), "notion-bridge-win-home-"));
  const stubBinDir = path.join(tempRoot, "stub-bin");
  const appData = path.join(tempRoot, "AppData", "Roaming");
  const localAppData = path.join(tempRoot, "AppData", "Local");
  argvLog = path.join(tempRoot, "argv.log");

  // Get-Executable resolves ngrok via Get-Command -CommandType Application,
  // which is PATH-based, so a .cmd shim ahead of PATH works the same way
  // the POSIX stubs do for the other two platforms.
  mkdirSync(stubBinDir, { recursive: true });
  writeFileSync(
    path.join(stubBinDir, "ngrok.cmd"),
    `@echo off\r\n(echo ==CALL==& echo ngrok %*& echo ==END==) >> "%STUB_ARGV_LOG%"\r\nexit /b 0\r\n`,
  );

  // Register-ScheduledTask (and the lifecycle cmdlets around it) is the one
  // per the brief: it has no PATH-based equivalent to stub, so it's shadowed
  // by a same-session global function instead. See windows-harness.ps1.
  result = spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      path.join(PROJECT_ROOT, "test", "installers", "lib", "windows-harness.ps1"),
      "-TargetScript",
      path.join(PROJECT_ROOT, "scripts", "install-windows.ps1"),
      "-TargetArgs",
      `-PublicHost:${HOST}`,
      "-Port:" + PORT,
      "-ArgvLog",
      argvLog,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        USERPROFILE: tempRoot,
        APPDATA: appData,
        LOCALAPPDATA: localAppData,
        PATH: `${stubBinDir};${process.env.PATH}`,
        STUB_ARGV_LOG: argvLog,
      },
      timeout: 90_000,
    },
  );

  if (result.status === 0 || result.status === 1) {
    const configFile = path.join(appData, "notion-cowork-bridge", "bridge.json");
    if (existsSync(configFile)) {
      config = JSON.parse(readFileSync(configFile, "utf8"));
    }
  }
});

after(() => {
  if (!IS_WINDOWS || !tempRoot) return;
  rmSync(tempRoot, { recursive: true, force: true });
});

test(
  "runs to completion, stopping only at the (stubbed) health check",
  { skip: skipReason() },
  () => {
    if (!pwshAvailable()) {
      assert.fail("pwsh is required to run this test on Windows.");
    }
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not become healthy/);
  },
);

test(
  "copies the whole src tree and installs real dependencies with --ignore-scripts",
  { skip: skipReason() },
  () => {
    const runtimeRoot = path.join(localAppData(), "notion-cowork-bridge");
    assert.ok(existsSync(path.join(runtimeRoot, "src", "server.js")));
    assert.ok(existsSync(path.join(runtimeRoot, "node_modules", "@modelcontextprotocol")));
    assert.ok(existsSync(path.join(runtimeRoot, "node_modules", "zod")));
  },
);

test("writes a config file with a token creation timestamp", { skip: skipReason() }, () => {
  assert.ok(config, "expected bridge.json to have been written");
  assert.equal(config.AllowedHosts, HOST);
  assert.match(config.TokenCreatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("records the expected stub invocations", { skip: skipReason() }, () => {
  const raw = readFileSync(argvLog, "utf8");
  const lines = raw.split("\n").filter(Boolean);
  const calls = lines.map((line) =>
    line.startsWith("{") ? JSON.parse(line) : { name: "ngrok", raw: line },
  );

  const registerCalls = calls.filter((c) => c.name === "Register-ScheduledTask");
  assert.equal(registerCalls.length, 2, "expected two Register-ScheduledTask calls");
  const bridgeTask = registerCalls.find((c) => c.args.TaskName === "NotionCoworkBridge");
  assert.ok(bridgeTask, "expected a NotionCoworkBridge task registration");

  const startCalls = calls.filter((c) => c.name === "Start-ScheduledTask");
  assert.equal(startCalls.length, 2, "expected two Start-ScheduledTask calls");
});

function localAppData() {
  return path.join(tempRoot, "AppData", "Local");
}
