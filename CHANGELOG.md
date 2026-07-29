# Changelog

Notable changes to this project. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.2] - 2026-07-29

### Fixed

- Make repeat macOS migrations reliable by waiting for launchd job teardown and treating inactive legacy plist files as archived configuration rather than active duplicate services.

## [1.3.1] - 2026-07-29

### Fixed

- Align Notion-facing terminal descriptions and workspace_info with the audit-only terminal policy and the configured process, preview, and browser limits.
- Allow browser_interact to fill multiple snapshot references in one call.

## [1.3.0] - 2026-07-29

### Added

- Isolated local-browser tools backed by Playwright Core and an installed Chrome, Chromium, or Edge executable.
- A temporary ngrok Agent API preview relay with one-time bootstrap links, host-only cookies, root-path asset handling, and WebSocket forwarding.
- `http_request` for consequential loopback requests; `http_probe` is now limited to GET and HEAD.

### Changed

- Terminal commands are audit-only: no command pattern is denied by the bridge, while sensitive-looking command text is redacted before persistence.
- Authentication runs before JSON parsing; searches run regular expressions in terminable workers; background logs and histories are bounded.

## [1.2.0] - Unreleased draft

Six tools became twenty-one, and an external review found three things wrong
with the six I already had. The fixes matter more than the additions, so
they're first.

### Fixed

- **The 1 MiB write limit never existed.** `createMcpExpressApp()` installed
  body-parser with its default 100 KB limit, app-wide, so the real ceiling was
  about 90 KB of content — a documented feature that had never once worked.
  Worse, oversized requests were rejected by the transport rather than the tool,
  as an HTML error page rendered by Express's default handler, which meant an
  **unauthenticated** POST larger than 100 KB to the public ngrok URL came back
  with my absolute install path, my username, and the `node_modules` layout.
  That defeated the one thing `/health` was carefully written not to do. The app
  is now built explicitly, the body limit is 4 MiB and applied only to `/mcp`, a
  terminal error handler returns JSON-RPC and never a stack, and `NODE_ENV` is
  `production` in all three service definitions and defaulted in-process
  besides. 1 MiB writes work now.
- **`write_text_file` destroyed the file's mode.** The temp file was created
  `0600` and renamed over the target, and rename replaces the inode — so a
  `0755` script came back non-executable, with a mode change in `git diff` that
  nobody asked for. It now `stat`s the target and restores its mode, and
  `fsync`s before the rename so a crash can't leave a zero-length file where a
  good one was.
- **Backgrounding anything hung the call.** `runCommand` resolved on the child's
  `close` event, which doesn't fire until every inherited pipe closes, so
  `npm run dev &` blocked the tool for the full two minutes and was then killed
  as a process group. Measured: the shell exits at 9 ms, `close` fires at
  6021 ms. There's a proper background-process family now, and the README's
  troubleshooting entry that blamed this on a missing TTY was wrong — a child
  gets `/dev/null` on stdin, so `sudo` and friends fail fast rather than
  hanging.
- Command output was capped per stream, so "combined output is capped at
  256 KiB" was really 512 KiB. It's one shared budget now, it keeps the first
  64 KiB and the last 128 KiB instead of the first 192 KiB (for build output the
  end is the part you want), and it cuts with `StringDecoder` so a multi-byte
  character at the boundary is dropped cleanly rather than becoming `U+FFFD`.
- Shutdown could hang forever on a keep-alive connection from the tunnel and get
  SIGKILLed, losing the in-flight `run_terminal_command.finish` record. It now
  closes connections and forces an exit after five seconds.
- An async `res.on("close")` listener could reject with nobody catching it,
  which under Node 20 takes the whole bridge down — a client aborting
  mid-request was a free remote DoS. Fixed, and there are `uncaughtException`
  and `unhandledRejection` handlers that write a `process.fatal` record before
  exiting.
- The audit log grew forever and cached a directory handle that went stale if
  the state directory was removed. It rotates at 10 MB keeping five files, and
  rechecks the directory after a failed write.
- `read_text_file` size-gated before honouring `start_line`/`end_line`, so you
  couldn't read the first 50 lines of a 300 KB log. It streams the range now.
  It also silently converted CRLF files to LF on a read/edit/write round trip;
  line endings, a trailing newline, and a BOM are all detected and preserved.
- `src/server.js` hardcoded its own version string independently of
  `package.json`.

### Added

- **`edit_text_file`.** Exact-string replacement with a list of edits, atomic
  across the whole list — if any `old_string` is missing or ambiguous, nothing
  is written — returning a unified diff rather than the new file, with a
  `dry_run` that shows the diff without touching anything. Changing one line of
  a 40 KB file no longer means re-emitting 40 KB through a credit-metered model.
- **`if_sha256` on `write_text_file` and `edit_text_file`.** A write from a
  stale read is rejected instead of quietly clobbering whatever you changed in
  your editor while the agent was thinking.
- **`search_text` and `glob_files`.** Regex and name search inside the
  workspace, without shelling out. Every search served this way is one fewer
  `grep` through the unrestricted tool, which is one fewer approval prompt to
  read carefully — a security improvement dressed as a convenience.
- **`delete_path` and `move_path`**, workspace-scoped and symlink-refusing.
  `delete_path` moves into `.bridge-trash/` unless you ask for `permanent`, so
  an agent's mistake is recoverable.
- **`read_bytes`**, for binary files and for anything past the read limit, and
  **`read_media_file`**, because the agent previously couldn't read back an
  image it had just produced.
- **Background processes**: `start_background_process`,
  `list_background_processes`, `read_process_output`, `stop_background_process`.
  Spawned detached with output redirected to a log file, tracked in a registry
  that survives a restart, killed as a group on stop and on shutdown.
- **`http_probe`.** One HTTP request to a loopback port, with a text mode that
  strips scripts and tags. It takes a port number and not a URL on purpose:
  there is no hostname for a poisoned README to point at your cloud metadata
  endpoint.
- **`share_preview` and `stop_preview`.** A local port behind the bridge's own
  public URL, with a random path token, a TTL, and a mandatory
  `confirm_public: true`. This is a genuinely new exposure — a dev server on a
  public URL routinely serves source maps, `.env` through the bundler, and admin
  routes that assume localhost means trusted — and it has its own section in
  `SECURITY.md` saying so.
- **`capture_screenshot`**, driving a browser you already have. No headless
  browser is bundled; a 300 MB dependency would have ended the "read the code
  before you install it" story outright.
- **A hash-chained audit log.** Every record carries `prevHash`, so editing the
  log breaks every line after the edit and tampering becomes detectable.
  Records are also mirrored to the OS log — `logger`, journald, or the Windows
  Event Log — which a user process can append to but not rewrite in place.
  Neither of these prevents anything; both are covered honestly in
  `SECURITY.md`.
- **Failed authentication is audited.** `auth.failure` with source address,
  path, user agent and a running count, plus escalating per-source backoff, and
  `auth.success` on `initialize`. A 64-character token isn't going to be
  guessed; the point is that evidence of scanning is how you find out the URL
  leaked.
- **A catastrophic-command trip-wire.** Seven patterns refused outright — piping
  a download into a shell, reading a private SSH key, `rm -rf ~`, dumping the
  keychain, minting an AWS session token. It is a speed bump, trivially bypassed
  by anyone actually trying, and it exists because the realistic injected
  payload is a lazy copy-paste. Separately, anything touching `.ssh`, `.aws`,
  `.npmrc`, `.git-credentials`, `.env`, a keychain or a pipe-to-shell is marked
  `flagged: true` in the audit record whether it ran or not, so
  `jq 'select(.flagged)'` is a review you can actually do.
- **`scripts/bridge` and `scripts/bridge.ps1`**, one dispatcher over eighteen
  per-platform scripts: `install`, `doctor`, `token`, `rotate`, `uninstall`,
  `logs`, `audit`, and `set-workspace`. Changing the workspace no longer means
  re-running the installer.
- **`npm run dev`.** A throwaway token, no ngrok, no service registration,
  nothing written outside the checkout, and a ready-to-paste `curl`. You can
  evaluate the whole thing before deciding whether to install it.
- `examples/ngrok-traffic-policy.yml`, an optional second factor at the ngrok
  edge that 404s anything without a header value you chose, wired up through
  `--traffic-policy-file`.
- Stable error codes (`E_OUTSIDE_WORKSPACE`, `E_PRECONDITION_FAILED`,
  `E_TOO_LARGE`, and seventeen more) returned as JSON, so an agent can branch on
  the failure instead of parsing English at it.
- Default ignore lists for `list_files`, `search_text` and `glob_files` —
  `.git`, `node_modules`, `dist`, `build`, `target`, `.venv`, `__pycache__`,
  `.bridge-trash`, plus the workspace's `.gitignore`. A 1,000-entry listing at
  depth 4 used to be entirely `node_modules`.
- Token age tracking, with `doctor` warning past 90 days.
- HTTP server timeouts (headers 15 s, request 30 s, keep-alive 15 s) against
  slowloris through the tunnel.
- End-to-end installer tests against stubbed system binaries, so the two
  platforms that shipped unexercised no longer do.

### Changed

- **`src/server.js` is no longer one file, and the README says so plainly.** It
  went from 764 lines to 427, with the primitives in `src/lib/` and one file per
  group of tools in `src/tools/`. "Read this one file before you install it" was
  the strongest thing this project had to say about trust, and 2,500 lines in
  one file would have been that sentence turning into a lie. The split is the
  less-bad option, not an improvement, and the README is written that way. No
  framework, no plugin system, no dependency injection; `src/lib/README.md`
  states the contract and the per-file line budgets.
- A second foreground command now waits up to ten seconds for the slot instead
  of failing immediately, and says to retry when it does fail.
- The installers pass `--ignore-scripts` to `npm ci`. Install-time lifecycle
  scripts are the most-exploited supply-chain foothold there is and neither
  dependency needs them.
- `workspace_info` reports live previews and background processes alongside the
  limits, so both you and the agent can see what is currently exposed.
- `write_text_file` and `create_directory` now write `.start` and `.finish`
  records like everything else, rather than one record after the fact.

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


[1.2.0]: https://github.com/soumosa/notion-cowork-bridge/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/soumosa/notion-cowork-bridge/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/soumosa/notion-cowork-bridge/releases/tag/v1.0.0
