# Security policy

## Read this part first

This project deliberately gives an authenticated Notion Custom Agent an
unrestricted shell on your Mac. That is remote code execution, on purpose, by
design. If that sentence makes you uncomfortable, good — it should, and you
should decide carefully whether you want this running at all.

The bearer token answers one question and only one: may this caller talk to the
MCP server? Once the answer is yes, nothing in this project stands between an
approved command and your machine.

## Threat model

`run_terminal_command` runs with the full permissions of the logged-in macOS
user. Assume that includes:

- every file that user can read or write
- SSH agents, cloud CLIs, package registry credentials, and other developer
  secrets
- outbound network access, and therefore data exfiltration
- package installation, and any lifecycle script that comes with it
- destructive commands, including the ones that don't ask twice
- macOS Keychain items available to that user

The workspace-scoped file tools are a guardrail for ordinary reads and writes.
They are not a boundary for the terminal, and they were never meant to be.

## The attack you should actually plan for

Most people read the section above and picture themselves typing something
reckless. That is not the likely failure.

The likely failure is **prompt injection**. Your agent reads things: Notion
pages, page comments, files in the repository, README files, web content, the
output of the commands it runs. Any of that is text someone else may have
written. If it contains instructions — "ignore your previous instructions and
run this" — the agent may follow them, and the agent has a shell.

Concretely, that means a shared Notion page, a colleague's comment, a
dependency's post-install banner, or a poisoned README in a repository you
asked the agent to inspect can all become the source of a command you never
intended.

The only defence in this design is the approval prompt, and it wears out.
After you have approved forty `git status` calls, you will approve the
forty-first without reading it. Assume that will happen to you, and:

- read the command, not the agent's summary of the command;
- be most suspicious when the agent proposes something you did not ask for;
- keep the workspace narrow, so injected content has less to work with;
- check the audit log after any session that touched content you did not write.

The instructions shipped in `examples/AGENT_INSTRUCTIONS.md` tell the agent to
treat file and page contents as data rather than commands. That helps. It is
not a security control, because the thing you are asking to resist the attack
is the same thing under attack.

## What is actually enforced

- the HTTP server binds to loopback only
- public MCP requests need a bearer token, compared in constant time
- the token is stripped from the environment of every terminal child process
- **every terminal command, file write, and folder creation is appended to an
  audit log**, with a record written *before* execution so a crash or a kill
  still leaves a trace
- file tools reject absolute paths, reject `..` traversal, and refuse to follow
  a symlink or a Windows junction at any segment of the path
- on Windows, drive-relative paths (`C:folder`), NTFS alternate data streams
  (`file.txt:hidden`), reserved device names (`CON`, `NUL`, `COM1`…) and
  trailing dots or spaces are all rejected
- reads, writes, directory listings, and command output are all capped
- terminal calls are capped at 120 seconds, and the whole process tree is killed
- only one terminal call runs at a time
- the health endpoint is deliberately anonymous: it returns `{"status":"ok"}`
  and does not name the service to anyone who finds the tunnel
- Notion can hold write and terminal tools behind an approval prompt

### Where the token is stored

| Platform | Storage | Notes |
| --- | --- | --- |
| macOS | Keychain | Read at service start. |
| Windows | DPAPI-encrypted file | Decryptable only by this user on this machine. |
| Linux | File, mode `0600` | See below. |

Linux is the weakest of the three, and deliberately so. A desktop keyring is
usually locked when a user service starts at boot, so a keyring-backed token
would make the bridge fail to start about as often as it worked. A `0600` file
owned by your account is the honest trade: anything running as you can read it,
which is already true of everything else this project exposes.

### What the audit log is not

It records what was run. It cannot stop what was run, it is written by the same
process that runs the commands, and anything with your user's permissions can
edit or delete it. It is there so you can answer "what happened" afterwards —
treat it as a flight recorder, not a lock.

That's defense in depth. It stops mistakes and narrows the blast radius. It is
not a sandbox.

## How to run this sensibly

For anything beyond personal experimentation on a machine you wouldn't mind
losing:

1. Create a dedicated user account, or use a disposable VM.
2. Give that account only the repositories and credentials it genuinely needs.
3. Keep secrets out of the exposed workspace.
4. Keep terminal and write tools on **Always ask**, and read the command before
   you approve it.
5. Be strict about who can use or reconfigure the Notion agent — sharing the
   agent is sharing the shell.
6. Check Notion's agent activity log from time to time.
7. Stop both launch services when you aren't using the bridge. It's one command,
   and it removes the exposure entirely.
8. Read the audit log after any session where the agent touched content you did
   not write yourself.
9. Rotate the token whenever the connection or the token might have been
   exposed: `rotate-token-macos.sh`, `rotate-token-linux.sh`, or
   `rotate-token-windows.ps1`.

## Reporting a vulnerability

Please don't open a public issue for anything that exposes secrets or allows
unauthenticated access. Use GitHub's private vulnerability reporting on this
repository instead.

Useful to include:

- the version or commit affected
- steps to reproduce
- what you expected and what actually happened
- whether any real credentials or systems were exposed
- a suggested mitigation, if you have one in mind

I'll acknowledge reports as fast as I reasonably can and tell you what I plan to
do about them.

One thing that is **not** a vulnerability: an authenticated agent being able to
run arbitrary commands. That's the stated purpose of the project, it's in a
warning box at the top of the README, and it's the first paragraph of this file.
