# Notion Cowork Bridge

Give a Notion Custom Agent real file tools and a real macOS terminal, over the
Model Context Protocol.

I kept hitting the same wall: the plan, the spec, and the task list all lived in
Notion, but the moment there was actual work to do I had to leave for a coding
app, do the work there, and then come back and write down what happened. This
bridge closes that loop. The agent reads a folder on my Mac, edits files, runs
Git, installs packages, runs the tests, and reports back — in the same thread
where the task was written.

> [!CAUTION]
> The terminal is **not sandboxed**, and that's deliberate. A command can reach
> anything your macOS user can reach: files outside the workspace, your network,
> your developer credentials, and destructive system commands. Please read
> [Security](#security) and [SECURITY.md](SECURITY.md) before you install this.

## What you get

| MCP tool | What it does | Character |
| --- | --- | --- |
| `workspace_info` | Reports the active boundary and every enforced limit | Read-only |
| `list_files` | Lists folders and files | Read-only |
| `read_text_file` | Reads UTF-8 files, whole or by line range | Read-only |
| `write_text_file` | Creates or replaces a UTF-8 file | Write |
| `create_directory` | Creates one folder | Write |
| `run_terminal_command` | Runs your normal shell, with network access | Unrestricted |

The five file tools are strict: they reject absolute paths, reject `..`
traversal, and refuse to follow symlinks. The terminal starts inside the
workspace but is free to leave it — that's the whole point of it, and also the
reason the warning above is worded the way it is.

```mermaid
flowchart LR
    A["Notion Custom Agent"] -->|"HTTPS + bearer token"| B["ngrok assigned domain"]
    B --> C["Local MCP bridge<br/>127.0.0.1:3210"]
    C --> D["Scoped file tools"]
    C --> E["Normal macOS shell"]
    D --> F["Chosen workspace"]
    E --> F
    E --> G["Network and user-accessible files"]
```

## Where this fits next to Claude Cowork or Codex

If Notion is already where you plan, write specs, and track work, this gets you
a surprising amount of the way there. You get a persistent agent with reusable
instructions, your Notion pages and databases as project context, real local
execution, scheduled and event-driven runs, and Notion's own activity history
and sharing controls around all of it.

It is not a drop-in replacement for a dedicated coding agent. There's no
code-review UI, no terminal emulation, no worktrees, no local checkpoints, and
no editor-native diff. Commands are non-interactive and capped at two minutes
each. I use it for the kind of work that's mostly reading, small edits, and
verification — not for a long refactor I'd want to watch closely.

## What you need

- macOS
- Node.js 20 or newer
- an [ngrok](https://ngrok.com/) account with the agent authenticated
- a Notion workspace where Custom Agents and custom MCP connections are enabled

Notion currently documents MCP connections for Custom Agents as a Business or
Enterprise feature, and a workspace owner may additionally need to turn on
custom servers under **Settings → Notion AI → AI connectors → Enable Custom MCP
servers**. Notion's [MCP integration guide](https://www.notion.com/help/guides/connect-custom-agents-to-mcp-integrations)
and [Custom Agents docs](https://www.notion.com/help/custom-agents) are the
source of truth here, and both change fairly often.

## Setup

### 1. Install the prerequisites

```sh
brew install node ngrok
ngrok config add-authtoken YOUR_NGROK_AUTHTOKEN
```

Your ngrok dashboard assigns you a development domain that looks like
`example-name.ngrok-free.dev`. You need that exact hostname for the next steps.
The free plan gives you one assigned domain and background endpoints, within its
[usage limits](https://ngrok.com/docs/pricing-limits/free-plan-limits).

### 2. Clone it and look around

```sh
git clone https://github.com/sourabhmorankar/notion-cowork-bridge.git
cd notion-cowork-bridge
npm ci
npm test
```

You're about to expose a shell to a remote agent, so read
[src/server.js](src/server.js) before you go further. It's a single file, about
600 lines, and every limit in it is named in one place at the top.

### 3. Do a dry run first

Swap in your hostname and the folder you actually want to expose:

```sh
./scripts/install-macos.sh \
  --host example-name.ngrok-free.dev \
  --workspace "$HOME/Desktop/notion-workspace" \
  --dry-run
```

That validates your arguments and prints the plan without touching anything. If
the plan looks right, run it again without `--dry-run`.

The installer copies a minimal runtime to
`~/.local/share/notion-cowork-bridge`, creates the workspace if it doesn't
exist, generates a 64-character bearer token and puts it in the macOS Keychain,
installs two per-user launch services (the bridge and the tunnel), starts them,
and waits for the local health check to pass.

No `sudo` anywhere. The services come up after login and restart themselves if
they die.

### 4. Grab the token

```sh
./scripts/show-token-macos.sh
```

Treat it like a password. Don't commit it, don't paste it into an issue, and
don't park it in a Notion page — anyone with the token and the URL gets a shell
on your Mac.

### 5. Wire up the connection in Notion

1. Create or open a Notion Custom Agent.
2. Open the agent's **Settings**.
3. Under **Tools & Access**, choose **Add connection**.
4. Choose **Custom MCP server**.
5. Fill in:
   - **URL:** `https://example-name.ngrok-free.dev/mcp`
   - **Name:** `Local Cowork Bridge`
   - **Authentication:** `Bearer token`
   - **Token:** the value from step 4
6. Connect, then save the agent.
7. Leave the three read tools on **Run automatically**.
8. Leave `write_text_file`, `create_directory`, and `run_terminal_command` on
   **Always ask**. Notion recommends this too, and I'd keep it that way well
   past the point where you've stopped being nervous about it.

### 6. Give the agent its operating instructions

Copy [examples/AGENT_INSTRUCTIONS.md](examples/AGENT_INSTRUCTIONS.md) into the
agent's Instructions field and adapt it to your project. Then start small:

> Use Local Cowork Bridge. First report the workspace boundary and list the
> top-level files. Don't modify anything yet.

Once that works:

> Inspect this project, explain how it's structured, and propose a short plan
> plus the checks that would disprove your plan.

And when you trust it:

> Create a Bun project in `experiments/hello`, install its dependencies, run its
> tests, and report the exact commands and results.

## How I actually use it

The loop that works for me:

1. Link the Notion spec or task page so the agent has the requirement in front
   of it.
2. Ask it to inspect the code without editing anything.
3. Approve a bounded plan — and the check that would prove the plan wrong.
4. Approve terminal and write calls one at a time. Read them first.
5. Make it run the tests and then actually inspect the resulting files, not just
   the exit code.
6. Review the diff myself before anything gets committed.

More prompts I reuse are in [examples/PROMPTS.md](examples/PROMPTS.md).

## Keeping it running

Check the whole installation at once:

```sh
./scripts/doctor-macos.sh
```

Watch the logs:

```sh
tail -f "$HOME/Library/Logs/notion-cowork-bridge/bridge.log"
tail -f "$HOME/Library/Logs/notion-cowork-bridge/tunnel.log"
```

Restart either service:

```sh
launchctl kickstart -k "gui/$(id -u)/com.notion-cowork-bridge.mcp"
launchctl kickstart -k "gui/$(id -u)/com.notion-cowork-bridge.tunnel"
```

Stop everything right now:

```sh
launchctl bootout "gui/$(id -u)/com.notion-cowork-bridge.mcp"
launchctl bootout "gui/$(id -u)/com.notion-cowork-bridge.tunnel"
```

Re-running the installer restores or updates both services.

## Troubleshooting

**Notion says it can't connect.** Check the public endpoint yourself first:

```sh
curl -i https://example-name.ngrok-free.dev/health
```

A `200` with `{"status":"ok"}` means the tunnel and bridge are both fine and the
problem is on the Notion side — usually the URL is missing the `/mcp` suffix.

**Everything returns 401.** The token in Notion doesn't match the one in the
Keychain. Re-copy it with `./scripts/show-token-macos.sh` and paste it into the
connection again. Watch for a trailing space; that bites more often than you'd
expect.

**The public health check fails but the local one passes.** The tunnel is down.
Look at `tunnel.log` — the usual causes are an expired ngrok authtoken, a
different domain than the one you installed with, or another `ngrok` process
already holding the domain. `pkill ngrok` and then kickstart the tunnel service.

**`doctor-macos.sh` reports a missing Keychain token.** macOS prompts before
letting a script read the Keychain, and a denied prompt looks identical to a
missing entry. Run `./scripts/show-token-macos.sh` in Terminal and choose
**Always Allow**.

**The bridge won't start and `bridge.log` mentions `MCP_AUTH_TOKEN`.** The
launch service couldn't read the Keychain, so the server refused to boot with a
short or empty token. Same fix as above.

**A command times out at exactly two minutes.** That's the hard cap, and it's
not configurable from Notion. Split the work, or run the long part yourself.

**A command hangs and then fails with no useful output.** It was waiting for
input. Nothing here has a TTY, so anything that prompts — `sudo`, an SSH
passphrase, an interactive `git rebase` — will just sit there until the timeout.

**`list_files` says symbolic links are not allowed.** That's working as
intended: the file tools never follow a link, because a link is the easiest way
out of the workspace. Use `run_terminal_command` if you genuinely need the
target.

**The Mac went to sleep.** Both services stop answering. The Mac has to be
logged in, awake, and online for any of this to work.

## Rotating the token

Rotate whenever the token might have leaked, when someone leaves the agent's
share list, or just periodically:

```sh
./scripts/rotate-token-macos.sh
```

It generates a fresh 64-character token, replaces the Keychain entry, and
restarts the bridge. The old token stops working immediately, so update the
connection in Notion right after — `./scripts/show-token-macos.sh` prints the
new value.

## Updating

```sh
git pull --ff-only
npm ci
npm test
./scripts/install-macos.sh \
  --host example-name.ngrok-free.dev \
  --workspace "$HOME/Desktop/notion-workspace"
./scripts/doctor-macos.sh
```

The installer keeps your existing Keychain token, so the Notion connection
survives an update untouched.

## Uninstalling

Stop the services and remove their launch definitions:

```sh
./scripts/uninstall-macos.sh
```

Add `--purge` to also delete the installed runtime, config, logs, and the
Keychain token:

```sh
./scripts/uninstall-macos.sh --purge
```

Your workspace is never deleted, purge or not.

## Running it from source

Handy while you're changing the server. [.env.example](.env.example) lists the
same variables; keep the real token in your shell or a secret manager rather
than in a file in the repo.

```sh
export MCP_AUTH_TOKEN="$(openssl rand -hex 32)"
export MCP_WORKSPACE_ROOT="$HOME/Desktop/notion-workspace"
export MCP_ALLOWED_HOSTS="localhost"
export MCP_PORT=3210
npm start
```

```sh
curl http://127.0.0.1:3210/health
```

Before you open a pull request:

```sh
npm run check
npm test
npm audit --omit=dev
```

The test suite needs a workspace outside the repo, since it verifies that the
bridge refuses to modify its own files. By default it uses two directories above
the repo; set `TEST_WORKSPACE_ROOT` to point it somewhere else. The Bun test
skips itself if Bun isn't installed.

## Configuration

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | none | Required bearer token, minimum 32 characters |
| `MCP_WORKSPACE_ROOT` | `~/Desktop/notion-workspace` | File-tool root, and where commands start |
| `MCP_ALLOWED_HOSTS` | none | Comma-separated public hostnames the server will answer for |
| `MCP_PORT` | `3210` | Loopback HTTP port |
| `SHELL` | `/bin/zsh` | Shell used for terminal commands |

The server always binds to `127.0.0.1`. The only public route is the one ngrok
gives you.

## Security

The bearer token answers exactly one question: may this caller talk to the MCP
server? It does nothing to constrain what an authenticated agent then does.

Assume `run_terminal_command` can:

- read your SSH keys, cloud credentials, browser data, and anything else your
  user can read
- modify or delete files anywhere outside the workspace
- install packages and run their lifecycle scripts
- send data over the network
- call the macOS Keychain tools available to your login

How I'd deploy it:

- use a dedicated macOS account or a disposable VM
- expose a purpose-built workspace, never your home directory
- keep the terminal and write tools on **Always ask**
- never approve a command you don't understand
- keep secrets out of the workspace
- don't share an agent that has this connection with people you wouldn't hand a
  terminal to
- stop both launch services when you're not using the bridge

The bridge does strip its own bearer token from child command environments, cap
combined command output, allow only one terminal command at a time, and enforce
a 120-second ceiling. Those controls prevent accidents. They are not a sandbox
and won't stop a determined command.

The full threat model and the disclosure process are in [SECURITY.md](SECURITY.md).

## Known limits

- macOS is the only platform with a supported installer.
- The Mac has to be logged in, awake, online, and running both services.
- Commands are non-interactive. Anything that prompts for input will fail.
- Command output is capped at 256 KiB.
- Text reads are capped at 256 KiB; writes at 1 MiB.
- The terminal timeout tops out at two minutes.
- File tools never follow symlinks.
- Notion controls plan availability, credits, model access, and Custom Agent
  behavior, and any of it can change without notice.
- ngrok's plan limits apply on top of everything else.

## Contributing

Bug reports and pull requests are welcome — see
[CONTRIBUTING.md](CONTRIBUTING.md) for what I look for. If you've found a
security issue, please use GitHub's private vulnerability reporting instead of
an issue.

## Project status

This is an independent side project of mine. It isn't affiliated with or
endorsed by Notion, Anthropic, OpenAI, or ngrok. "Notion," "Claude," "Cowork,"
"Codex," and "ngrok" belong to their respective owners.

## License

[MIT](LICENSE) — Sourabh Morankar
