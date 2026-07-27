#!/usr/bin/env node
/**
 * Syntax-check everything in the repository that has a checker available on
 * this machine, and say plainly what was skipped. Interpreters differ per
 * platform, so a missing one is reported rather than treated as a pass.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");

let failed = 0;
const skipped = [];

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8" });
  if (result.error || result.status !== 0) {
    failed += 1;
    console.error(`FAIL  ${label}`);
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim();
    if (detail) console.error(detail.split("\n").map((l) => `      ${l}`).join("\n"));
    return;
  }
  console.log(`ok    ${label}`);
}

function available(command, args = ["--version"]) {
  const probe = spawnSync(command, args, { stdio: "ignore" });
  return !probe.error && probe.status === 0;
}

// 1. JavaScript
for (const file of ["src/server.js", "test/security.test.js", "scripts/check.mjs"]) {
  run(file, process.execPath, ["--check", path.join(ROOT, file)]);
}

// 2. Shell scripts, using whichever interpreter the shebang asks for.
const shellScripts = readdirSync(SCRIPTS).filter((name) => name.endsWith(".sh"));
for (const name of shellScripts) {
  const full = path.join(SCRIPTS, name);
  const shebang = readFileSync(full, "utf8").split("\n", 1)[0];
  const interpreter = shebang.includes("zsh") ? "zsh" : "bash";
  if (!available(interpreter)) {
    skipped.push(`scripts/${name} (${interpreter} not installed)`);
    continue;
  }
  run(`scripts/${name}`, interpreter, ["-n", full]);
}

// 3. PowerShell scripts, parsed rather than executed.
const powershellScripts = readdirSync(SCRIPTS).filter((name) => name.endsWith(".ps1"));
if (powershellScripts.length > 0) {
  const pwsh = ["pwsh", "powershell"].find((candidate) =>
    available(candidate, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"]),
  );
  if (!pwsh) {
    for (const name of powershellScripts) {
      skipped.push(`scripts/${name} (PowerShell not installed)`);
    }
  } else {
    for (const name of powershellScripts) {
      const full = path.join(SCRIPTS, name).replace(/'/g, "''");
      run(`scripts/${name}`, pwsh, [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `$errors = $null; ` +
          `[System.Management.Automation.Language.Parser]::ParseFile('${full}', [ref]$null, [ref]$errors) | Out-Null; ` +
          `if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`,
      ]);
    }
  }
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} file(s) with no checker on this platform:`);
  for (const entry of skipped) console.log(`  - ${entry}`);
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll available checks passed.");
