#!/usr/bin/env node
/**
 * Syntax-check everything in the repository that has a checker available on
 * this machine, and say plainly what was skipped. Interpreters differ per
 * platform, so a missing one is reported rather than treated as a pass.
 *
 * Set CHECK_STRICT=1 to turn every skip into a failure. CI sets this so a
 * checker quietly disappearing from a runner image breaks the build instead
 * of the check silently covering less than it used to.
 */
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(ROOT, "scripts");
const STRICT = process.env.CHECK_STRICT === "1";

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

/** Recursively collect .js/.mjs/.cjs files under a directory, if it exists. */
function collectJsFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectJsFiles(full));
    } else if (/\.(js|mjs|cjs)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// 1. JavaScript. Globbed rather than a fixed file list, so a source split
// into src/lib/*.js and src/tools/*.js (or a new script under scripts/)
// gets checked without anyone having to remember to update this file.
const jsFiles = [
  ...collectJsFiles(path.join(ROOT, "src")),
  ...collectJsFiles(path.join(ROOT, "test")),
  ...collectJsFiles(SCRIPTS),
].sort();
for (const file of jsFiles) {
  run(path.relative(ROOT, file), process.execPath, ["--check", file]);
}

// 2. Shell scripts, using whichever interpreter the shebang asks for.
// "bridge" has no .sh suffix (it's meant to be run as `./scripts/bridge`),
// so it's included by name.
const shellScripts = readdirSync(SCRIPTS).filter(
  (name) => name.endsWith(".sh") || name === "bridge",
);
const shellMeta = shellScripts.map((name) => {
  const full = path.join(SCRIPTS, name);
  const shebang = readFileSync(full, "utf8").split("\n", 1)[0];
  const interpreter = shebang.includes("zsh") ? "zsh" : "bash";
  return { name, full, interpreter };
});

for (const { name, full, interpreter } of shellMeta) {
  if (!available(interpreter)) {
    skipped.push(`scripts/${name} (${interpreter} not installed)`);
    continue;
  }
  run(`scripts/${name}`, interpreter, ["-n", full]);
}

// 3. shellcheck on the POSIX/bash scripts. zsh isn't one of shellcheck's
// supported dialects (sh, bash, dash, ksh), so the macOS scripts are
// intentionally left out here rather than reported as skipped; zsh -n above
// is their syntax check.
const shellcheckable = shellMeta
  .filter((entry) => entry.interpreter === "bash")
  .map((entry) => ({ ...entry, dialect: entry.name === "bridge" ? "sh" : "bash" }));
if (shellcheckable.length > 0) {
  if (available("shellcheck")) {
    for (const { name, full, dialect } of shellcheckable) {
      run(`shellcheck scripts/${name}`, "shellcheck", ["-s", dialect, full]);
    }
  } else {
    skipped.push("shellcheck (not installed)");
  }
}

// 4. PowerShell scripts, parsed rather than executed.
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

    // PSScriptAnalyzer, if the module is installed alongside whichever
    // PowerShell we found above.
    const analyzerAvailable =
      spawnSync(
        pwsh,
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "if (Get-Module -ListAvailable -Name PSScriptAnalyzer) { exit 0 } else { exit 1 }",
        ],
        { stdio: "ignore" },
      ).status === 0;
    if (analyzerAvailable) {
      for (const name of powershellScripts) {
        const full = path.join(SCRIPTS, name).replace(/'/g, "''");
        run(`PSScriptAnalyzer scripts/${name}`, pwsh, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `$results = Invoke-ScriptAnalyzer -Path '${full}' -Severity Error,Warning; ` +
            `if ($results) { $results | Format-Table -AutoSize | Out-String | Write-Error; exit 1 }`,
        ]);
      }
    } else {
      skipped.push("PSScriptAnalyzer (module not installed)");
    }
  }
}

if (skipped.length > 0) {
  console.log(`\nSkipped ${skipped.length} file(s) with no checker on this platform:`);
  for (const entry of skipped) console.log(`  - ${entry}`);
  if (STRICT) {
    failed += skipped.length;
    console.error("\nCHECK_STRICT=1: the skips above count as failures.");
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed.`);
  process.exit(1);
}
console.log("\nAll available checks passed.");
