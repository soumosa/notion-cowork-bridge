# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-07-27

### Added

- **Linux and Windows support.** `install-linux.sh` registers systemd user
  units; `install-windows.ps1` registers Scheduled Tasks at logon. Both ship
  matching doctor, show-token, rotate-token, and uninstall scripts. No `sudo`
  and no Administrator on either.
- **An audit log.** Every terminal command, file write, and folder creation is
  appended as one JSON line, with the start of a command recorded *before* it
  runs so a hang or a kill still leaves a trace. The bearer token is never
  written to it.
- Windows path hardening: drive-relative paths (`C:folder`), NTFS alternate
  data streams (`file.txt:hidden`), reserved device names (`CON`, `NUL`,
  `COM1`…) and trailing dots or spaces are all rejected. Junctions are refused
  alongside symlinks.
- A prompt-injection section in `SECURITY.md`, and instructions in
  `examples/AGENT_INSTRUCTIONS.md` telling the agent to treat file and page
  contents as data rather than commands. This is the attack that actually
  catches people and it wasn't documented.
- `MCP_SHELL` and `MCP_AUDIT_LOG` configuration variables.
- Tests for the audit log, the command timeout, the anonymous health endpoint,
  and the Windows path rules.
- Token rotation scripts for all three platforms. The README pointed at token
  rotation before there was any way to do it.
- A troubleshooting section in the README covering the failures I actually hit:
  401s, a dead tunnel, denied Keychain prompts, and commands that hang waiting
  for input they'll never get.
- Issue templates, a code of conduct, an `.editorconfig`, and this changelog.

### Changed

- Command execution is platform-aware: `-lc` for POSIX shells,
  `-NoProfile -NonInteractive -Command` for PowerShell, `/d /s /c` for `cmd`.
  Timeouts kill the whole process tree on every platform — POSIX by process
  group, Windows via `taskkill /T`.
- Workspace containment now compares case-insensitively on Windows, where a
  case-flipped prefix would otherwise read as an escape.
- `/health` no longer names the service. It returned
  `{"service":"notion-local-workspace"}`, which fingerprinted the bridge to
  anyone who found the tunnel domain.
- `npm run check` is a Node script that picks the right checker per file and
  reports what it had to skip, instead of assuming zsh exists.
- CI runs on Ubuntu, macOS, and Windows across Node 20, 22, and 24. Every
  runner image ships PowerShell, so the Windows scripts are parsed on all three.
- The Bun terminal test skips itself when Bun isn't installed instead of
  failing, and CI installs Bun so the test still runs there.
- `doctor` takes the first entry when `MCP_ALLOWED_HOSTS` holds several
  hostnames, rather than curling the whole comma-separated string.
- Repository metadata in `package.json`, and a named copyright holder in
  `LICENSE`.

### Fixed

- `install-macos.sh --help` printed `Usage: usage` — zsh expands `$0` inside a
  function to the function's name, not the script's.

## [1.0.0] - 2026-07-27

First release.

### Added

- MCP server exposing six tools over Streamable HTTP: `workspace_info`,
  `list_files`, `read_text_file`, `write_text_file`, `create_directory`, and
  `run_terminal_command`.
- Workspace-scoped file tools that reject absolute paths, reject `..` traversal,
  and refuse to follow symbolic links at any path segment.
- An unrestricted terminal tool that runs in the user's normal shell, with the
  bridge's own bearer token stripped from the child environment, one command in
  flight at a time, capped output, and a 120-second ceiling.
- Timing-safe bearer-token authentication, loopback-only binding, and a host
  allowlist for the public tunnel domain.
- macOS installer that provisions the runtime, generates a 64-character token
  into the Keychain, and registers launch services for the bridge and the ngrok
  tunnel — with `--dry-run` to preview the whole plan.
- `doctor`, `show-token`, `start-bridge`, and `uninstall` scripts.
- A security test suite covering authentication, traversal, symlink refusal,
  self-modification, and the terminal's deliberate lack of a sandbox.
- Agent operating instructions and a prompt cookbook under `examples/`.


[1.1.0]: https://github.com/soumosa/notion-cowork-bridge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/soumosa/notion-cowork-bridge/releases/tag/v1.0.0
