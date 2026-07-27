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

## What is actually enforced

- the HTTP server binds to loopback only
- public MCP requests need a bearer token, compared in constant time
- the installer stores that token in the macOS Keychain, never on disk in the
  clear
- the token is stripped from the environment of every terminal child process
- file tools reject absolute paths, reject `..` traversal, and refuse to follow
  a symlink at any segment of the path
- reads, writes, directory listings, and command output are all capped
- terminal calls are capped at 120 seconds
- only one terminal call runs at a time
- Notion can hold write and terminal tools behind an approval prompt

That's defense in depth. It stops mistakes and narrows the blast radius. It is
not a sandbox.

## How to run this sensibly

For anything beyond personal experimentation on a machine you wouldn't mind
losing:

1. Create a dedicated macOS user, or use a disposable VM.
2. Give that account only the repositories and credentials it genuinely needs.
3. Keep secrets out of the exposed workspace.
4. Keep terminal and write tools on **Always ask**, and read the command before
   you approve it.
5. Be strict about who can use or reconfigure the Notion agent — sharing the
   agent is sharing the shell.
6. Check Notion's agent activity log from time to time.
7. Stop both launch services when you aren't using the bridge. It's one command,
   and it removes the exposure entirely.
8. Rotate the Keychain token whenever the connection or the token might have
   been exposed: `./scripts/rotate-token-macos.sh`.

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
