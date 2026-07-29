/**
 * Fake system binaries for exercising a real installer script without
 * touching the real launchd/systemd/Keychain/ngrok on the machine running
 * the test. Each stub appends its name and argv to a shared log file (path
 * given via the STUB_ARGV_LOG environment variable at spawn time) and exits
 * 0, except `security`, which fails `find-generic-password` so the real
 * installer takes its normal "create a new token" branch instead of
 * touching the actual macOS Keychain.
 *
 * The log format is deliberately one token per line rather than a shell
 * quoting scheme, so arguments containing spaces (a plist path under
 * "Application Support", say) round-trip exactly with no escaping to get
 * wrong in either direction.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const RECORD_BLOCK = `{
  echo "==CALL=="
  echo "NAME_PLACEHOLDER"
  for a in "$@"; do printf '%s\\n' "$a"; done
  echo "==END=="
} >> "$STUB_ARGV_LOG"`;

function stubScript(name) {
  const record = RECORD_BLOCK.replace("NAME_PLACEHOLDER", name);
  if (name === "security") {
    return `#!/bin/sh
${record}
case "$1" in
  find-generic-password) exit 1 ;;
  *) exit 0 ;;
esac
`;
  }
  return `#!/bin/sh
${record}
exit 0
`;
}

/** Write one stub executable per name into binDir, ready to prepend to PATH. */
export function createStubBin(binDir, names) {
  mkdirSync(binDir, { recursive: true });
  for (const name of names) {
    const full = path.join(binDir, name);
    writeFileSync(full, stubScript(name));
    chmodSync(full, 0o755);
  }
  return binDir;
}

/** Parse the argv log back into [{ name, args }] in call order. */
export function readStubCalls(argvLogPath) {
  let raw;
  try {
    raw = readFileSync(argvLogPath, "utf8");
  } catch {
    return [];
  }
  const calls = [];
  for (const block of raw.split("==CALL==\n").slice(1)) {
    const lines = block.split("\n");
    const endIndex = lines.indexOf("==END==");
    const body = endIndex >= 0 ? lines.slice(0, endIndex) : lines;
    const [name, ...args] = body;
    calls.push({ name, args });
  }
  return calls;
}
