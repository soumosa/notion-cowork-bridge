import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createStubBin, readStubCalls } from "./lib/stub-bin.mjs";

const IS_LINUX = process.platform === "linux";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = "test-install.ngrok-free.dev";
const PORT = "33298";

function skipReason() {
  return IS_LINUX ? false : "This installer is Linux-only.";
}

let tempHome;
let argvLog;
let result;

before(() => {
  if (!IS_LINUX) return;

  tempHome = mkdtempSync(path.join(tmpdir(), "notion-bridge-linux-home-"));
  const stubBinDir = path.join(tempHome, "stub-bin");
  argvLog = path.join(tempHome, "argv.log");
  createStubBin(stubBinDir, ["ngrok", "systemctl", "loginctl"]);

  // Runs the real install-linux.sh end to end: real npm ci, real unit-file
  // generation, real systemd-analyze verify. Only ngrok/systemctl/loginctl
  // are faked, so nothing is actually registered with the real user session.
  //
  // Like the macOS installer, its own health check has nothing real to talk
  // to (the stub systemctl doesn't start anything), so it always finishes
  // by timing out after ~20s and exiting 1 -- expected, and asserted below.
  result = spawnSync(
    "bash",
    [
      path.join(PROJECT_ROOT, "scripts", "install-linux.sh"),
      "--host",
      HOST,
      "--port",
      PORT,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
        XDG_CONFIG_HOME: path.join(tempHome, ".config"),
        XDG_STATE_HOME: path.join(tempHome, ".local", "state"),
        PATH: `${stubBinDir}:${process.env.PATH}`,
        STUB_ARGV_LOG: argvLog,
      },
      timeout: 90_000,
    },
  );
});

after(() => {
  if (!IS_LINUX || !tempHome) return;
  rmSync(tempHome, { recursive: true, force: true });
});

test(
  "runs to completion, stopping only at the (stubbed) health check",
  { skip: skipReason() },
  () => {
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not become healthy/);
  },
);

test(
  "copies the whole src tree and installs real dependencies with --ignore-scripts",
  { skip: skipReason() },
  () => {
    const runtimeRoot = path.join(tempHome, ".local", "share", "notion-cowork-bridge");
    assert.ok(existsSync(path.join(runtimeRoot, "src", "server.js")));
    assert.ok(existsSync(path.join(runtimeRoot, "node_modules", "@modelcontextprotocol")));
    assert.ok(existsSync(path.join(runtimeRoot, "node_modules", "zod")));
  },
);

test(
  "writes 0600 config and token files with a creation timestamp",
  { skip: skipReason() },
  () => {
    const configDir = path.join(tempHome, ".config", "notion-cowork-bridge");
    const configFile = path.join(configDir, "bridge.env");
    const tokenFile = path.join(configDir, "token");

    assert.equal(statSync(configFile).mode & 0o777, 0o600);
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);

    const content = readFileSync(configFile, "utf8");
    assert.match(content, /^TOKEN_CREATED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    assert.match(content, new RegExp(`^MCP_ALLOWED_HOSTS=${HOST}$`, "m"));

    const token = readFileSync(tokenFile, "utf8").trim();
    assert.match(token, /^[0-9a-f]{64}$/);
  },
);

test(
  "generates a valid systemd unit for the bridge with NODE_ENV=production",
  { skip: skipReason() },
  () => {
    const unitPath = path.join(
      tempHome,
      ".config",
      "systemd",
      "user",
      "notion-cowork-bridge.service",
    );
    assert.ok(existsSync(unitPath));
    const content = readFileSync(unitPath, "utf8");
    assert.match(content, /^Environment=NODE_ENV=production$/m);

    const verify = spawnSync("systemd-analyze", ["verify", unitPath], { encoding: "utf8" });
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  },
);

test("records the expected stub invocations", { skip: skipReason() }, () => {
  const calls = readStubCalls(argvLog);

  const ngrokCheck = calls.find((c) => c.name === "ngrok" && c.args[0] === "config");
  assert.ok(ngrokCheck, "expected an `ngrok config check` call");

  const enableCalls = calls.filter(
    (c) => c.name === "systemctl" && c.args.includes("enable") && c.args.includes("--now"),
  );
  assert.equal(enableCalls.length, 2, "expected two `systemctl --user enable --now` calls");

  const linger = calls.find((c) => c.name === "loginctl" && c.args[0] === "enable-linger");
  assert.ok(linger, "expected a `loginctl enable-linger` call");
});
