# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `scripts/rotate-token-macos.sh`, which replaces the Keychain bearer token and
  restarts the bridge. The README pointed at token rotation before there was a
  way to do it.
- A troubleshooting section in the README covering the failures I actually hit:
  401s, a dead tunnel, denied Keychain prompts, and commands that hang waiting
  for input they'll never get.
- Issue templates, a code of conduct, an `.editorconfig`, and this changelog.

### Changed

- The Bun terminal test now skips itself when Bun isn't installed instead of
  failing, and CI installs Bun so the test still runs there.
- `scripts/doctor-macos.sh` takes the first entry when `MCP_ALLOWED_HOSTS` holds
  several hostnames, rather than curling the whole comma-separated string.
- Added repository metadata to `package.json`, and named the copyright holder in
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

[Unreleased]: https://github.com/sourabhmorankar/notion-cowork-bridge/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/sourabhmorankar/notion-cowork-bridge/releases/tag/v1.0.0
