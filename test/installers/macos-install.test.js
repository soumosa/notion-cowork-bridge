import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createStubBin, readStubCalls } from "./lib/stub-bin.mjs";

const IS_MACOS = process.platform === "darwin";
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const HOST = "test-install.ngrok-free.dev";
// Deliberately not the 3210 default: a real, unrelated service on the
// machine running this test could already be listening there, which would
// make the health check below pass against someone else's server instead
// of failing the way a stubbed install should.
const PORT = "33299";

function skipReason() {
  return IS_MACOS ? false : "This installer is macOS-only.";
}

let tempHome;
let argvLog;
let trafficPolicyFile;
let result;

before(() => {
  if (!IS_MACOS) return;

  tempHome = mkdtempSync(path.join(tmpdir(), "notion-bridge-macos-home-"));
  const stubBinDir = path.join(tempHome, "stub-bin");
  argvLog = path.join(tempHome, "argv.log");
  // ngrok and launchctl are the two the task calls out for macOS; security
  // is stubbed too so this test never touches the real login Keychain.
  createStubBin(stubBinDir, ["ngrok", "launchctl", "security"]);

  trafficPolicyFile = path.join(tempHome, "traffic-policy.yml");
  writeFileSync(trafficPolicyFile, "on_http_request: []\n");

  // Runs the real install-macos.sh end to end: real npm ci, real plist
  // generation, real plutil -lint. Only the launchd/Keychain/ngrok side
  // effects are faked, and only because a temp HOME plus stubbed launchctl
  // means nothing actually gets registered with the real launchd session.
  //
  // The script's own health check has nothing real to talk to (the stub
  // launchctl doesn't start a process), so it always finishes by timing out
  // after ~20s and exiting 1. That is expected here and asserted below;
  // everything before that point is real.
  result = spawnSync(
    "/bin/zsh",
    [
      path.join(PROJECT_ROOT, "scripts", "install-macos.sh"),
      "--host",
      HOST,
      "--port",
      PORT,
      "--traffic-policy-file",
      trafficPolicyFile,
    ],
    {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: tempHome,
        PATH: `${stubBinDir}:${process.env.PATH}`,
        STUB_ARGV_LOG: argvLog,
      },
      timeout: 90_000,
    },
  );
});

after(() => {
  if (!IS_MACOS || !tempHome) return;
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
  "writes a 0600 config file with the token creation timestamp and the requested host",
  { skip: skipReason() },
  () => {
    const configFile = path.join(tempHome, ".config", "notion-cowork-bridge", "bridge.env");
    const mode = statSync(configFile).mode & 0o777;
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    const content = readFileSync(configFile, "utf8");
    assert.match(content, /^TOKEN_CREATED_AT=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
    assert.match(content, new RegExp(`^MCP_ALLOWED_HOSTS=${HOST}$`, "m"));
  },
);

test(
  "generates a valid launchd plist for the bridge with NODE_ENV=production",
  { skip: skipReason() },
  () => {
    const plistPath = path.join(
      tempHome,
      "Library",
      "LaunchAgents",
      "com.notion-cowork-bridge.mcp.plist",
    );
    const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const content = readFileSync(plistPath, "utf8");
    assert.match(content, /<key>NODE_ENV<\/key>\s*<string>production<\/string>/);
    assert.match(content, /start-bridge-macos\.sh/);
  },
);

test(
  "waits for the previous bridge process to exit before bootstrapping its replacement",
  { skip: skipReason() },
  () => {
    const installer = readFileSync(
      path.join(PROJECT_ROOT, "scripts", "install-macos.sh"),
      "utf8",
    );
    const bootout = installer.indexOf(
      '"$launchctl_bin" bootout \\\n  "gui/$uid_value/com.notion-cowork-bridge.mcp"',
    );
    const wait = installer.indexOf("wait_for_bridge_exit", bootout);
    const bootstrap = installer.indexOf(
      '"$launchctl_bin" bootstrap "gui/$uid_value" "$bridge_plist"',
      wait,
    );
    assert.ok(bootout >= 0, "expected bridge bootout");
    assert.ok(wait > bootout, "expected an exit wait after bridge bootout");
    assert.ok(bootstrap > wait, "expected bootstrap only after the exit wait");
  },
);

test(
  "wires --traffic-policy-file into a valid tunnel plist",
  { skip: skipReason() },
  () => {
    const plistPath = path.join(
      tempHome,
      "Library",
      "LaunchAgents",
      "com.notion-cowork-bridge.tunnel.plist",
    );
    const lint = spawnSync("/usr/bin/plutil", ["-lint", plistPath], { encoding: "utf8" });
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
    const content = readFileSync(plistPath, "utf8");
    assert.ok(content.includes("--traffic-policy-file"));
    assert.ok(content.includes(trafficPolicyFile));
  },
);

test("records the expected stub invocations", { skip: skipReason() }, () => {
  const calls = readStubCalls(argvLog);

  const ngrokCheck = calls.find((c) => c.name === "ngrok" && c.args[0] === "config");
  assert.ok(ngrokCheck, "expected an `ngrok config check` call");

  const bootstrapCalls = calls.filter((c) => c.name === "launchctl" && c.args[0] === "bootstrap");
  assert.equal(bootstrapCalls.length, 2, "expected two `launchctl bootstrap` calls");

  const addPassword = calls.find(
    (c) => c.name === "security" && c.args[0] === "add-generic-password",
  );
  assert.ok(addPassword, "expected a Keychain add-generic-password call");
  assert.ok(addPassword.args.includes("dev.notion-cowork-bridge.mcp"));
});
