# Security policy

## Read this first

This project deliberately exposes an unrestricted shell to an authenticated
Notion Custom Agent. It is remote command execution by design.

The bearer token answers only one question: “May this caller use the MCP
server?” It does not sandbox an authorized command.

## Threat model

An authorized agent can use `run_terminal_command` with the permissions of the
logged-in macOS user. This may include:

- all user-readable and user-writable files;
- SSH agents, cloud CLIs, package registries, and developer credentials;
- network access and data exfiltration;
- package installation and arbitrary lifecycle scripts;
- destructive commands;
- macOS Keychain items available to that user.

The scoped file tools are not a security boundary for the terminal.

## Built-in controls

- the HTTP server binds only to loopback;
- public MCP requests require a timing-safe bearer-token check;
- the bearer token is stored in macOS Keychain by the installer;
- the token is removed from terminal child environments;
- file tools reject absolute paths, traversal, and symlinks;
- file reads, writes, listings, and command output are capped;
- terminal calls have a 120-second maximum;
- only one terminal call runs at a time;
- Notion can keep write and terminal tools behind an approval prompt.

These are defense-in-depth controls, not a sandbox.

## Recommended isolation

For anything more than personal experimentation:

1. Create a dedicated macOS user or disposable virtual machine.
2. Give that account only the repositories and credentials it needs.
3. Keep secrets outside the exposed workspace.
4. Keep terminal and write tools on **Always ask**.
5. Restrict who can use or configure the Notion agent.
6. Review Notion’s agent activity logs.
7. Stop the launch services when remote execution is unnecessary.
8. Rotate the Keychain token if the Notion connection or token is exposed.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that exposes secrets or enables
unauthenticated access. Use GitHub’s private vulnerability reporting feature
for the repository.

Include:

- the affected version or commit;
- reproduction steps;
- expected and observed behavior;
- whether credentials or systems were exposed;
- a suggested mitigation, if known.

Reports about an authenticated agent being able to run arbitrary commands are
not vulnerabilities; that is the explicit purpose of this project.
