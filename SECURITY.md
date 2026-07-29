# Security policy

## Read this part first

This project deliberately gives an authenticated Notion Custom Agent an
unrestricted shell on your machine. That is remote code execution, on purpose,
by design. If that sentence makes you uncomfortable, good — it should, and you
should decide carefully whether you want this running at all.

The bearer token answers one question and only one: may this caller talk to the
MCP server? Once the answer is yes, nothing in this project stands between an
approved command and your machine.

## Threat model

`run_terminal_command` and `start_background_process` run with the full
permissions of the logged-in user. Assume that includes:

- every file that user can read or write
- SSH agents, cloud CLIs, package registry credentials, and other developer
  secrets
- outbound network access, and therefore data exfiltration
- package installation, and any lifecycle script that comes with it
- destructive commands, including the ones that don't ask twice
- Keychain, credential manager, or secret store items available to that user

The workspace-scoped file, search and media tools are a guardrail for ordinary
reads and writes. They are not a boundary for the terminal, and they were never
meant to be.

`share_preview` is a different kind of exposure and has its own section below.
It does not need a shell and it does not need the bearer token — it needs
someone to have the link.

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

### The catastrophic-command trip-wire

The bridge does not deny commands by pattern. It runs commands with the local user's authority and records an audit-only risk marker for credential-oriented or pipe-to-shell shapes:
piping a `curl` or `wget` download into a shell, running one through process
substitution, `cat`-ing a private SSH key, `rm -rf ~`, `rm -rf /`,
`security dump-keychain`, and `aws sts get-session-token`. The refusal message
says what it is:

> Refused: *reason*. This is a speed bump, trivially bypassed by anyone actually
> trying — it exists because the realistic attack is lazy, not a safety
> guarantee. Run it yourself in a real terminal if you meant it.

I want to be precise about why this exists, because a deny-list in a security
document invites people to read it as a defence and it is not one. It is seven
regular expressions. Base64, a variable holding the URL, a here-doc, an
`eval`, or simply writing the payload to a file and running the file all walk
straight past it. Anyone who has thought about the bridge for ten minutes
defeats it.

It is here because the realistic injected payload has not thought about the
bridge for ten minutes. It is a line copied out of a blog post into a poisoned
README, and a line copied out of a blog post is exactly the shape a regular
expression catches. That is a low bar and a real one. It does not protect
anything, prevent anything, or block an attack; it makes the laziest version
of the attack fail, and buys nothing at all against a version aimed at you.

Separately, and more usefully: any command that so much as mentions `.ssh`,
`.aws`, `.npmrc`, `.git-credentials`, `.env`, a keychain, or a pipe into a
shell is written to the audit log with `flagged: true`, whether it was refused
or ran normally. That is the field to review:

```sh
jq 'select(.flagged)' audit.jsonl
```

If that returns nothing after a session, nothing went near your credentials. If
it returns something you did not ask for, you have found your prompt injection.
The flag is deliberately broader than the refusal list, because a marker on a
command that turns out to be innocent costs you a second of reading and a
missing marker costs you the incident.

## What is actually enforced

- the HTTP server binds to loopback only
- public MCP requests need a bearer token, compared in constant time
- failed authentication is audited and backed off per source address
- the bearer token *and everything that points at it* — `TOKEN_FILE`,
  `KEYCHAIN_ACCOUNT`, `KEYCHAIN_SERVICE`, `RUNTIME_ROOT`,
  `NOTION_COWORK_CONFIG`, and every `MCP_*` and `NGROK_*` variable — is stripped
  from the environment of every child process
- **every consequential action is appended to an audit log**: terminal commands,
  background processes, writes, edits, deletes, moves, folder creation, previews
  shared and hit, and failed authentication. A record is written *before*
  execution so a crash or a kill still leaves a trace
- the audit log is hash-chained and mirrored to the operating system's log
- file, search and media tools reject absolute paths, reject `..` traversal, and
  refuse to follow a symlink or a Windows junction at any segment of the path
- on Windows, drive-relative paths (`C:folder`), NTFS alternate data streams
  (`file.txt:hidden`), reserved device names (`CON`, `NUL`, `COM1`…) and
  trailing dots or spaces are all rejected
- reads, writes, directory listings, search results, and command output are all
  capped, with stdout and stderr sharing one combined output ceiling
- foreground terminal calls are capped at 120 seconds, and the whole process
  group is killed; tracked background processes are killed when the bridge stops
- only one foreground terminal call runs at a time
- `write_text_file` and `edit_text_file` accept an `if_sha256` precondition, so
  an agent working from a stale read is rejected rather than allowed to clobber
- `http_probe` takes a port number, never a hostname or a URL, and will not
  leave the loopback interface — there is nothing there for injected text to
  point at your cloud metadata endpoint or your router
- `share_preview` requires an explicit `confirm_public: true`, expires, and
  refuses to forward `..` or `/@fs/`
- the installers run `npm ci --ignore-scripts`, and the services run with
  `NODE_ENV=production` so no error handler renders a stack trace to the tunnel
- the health endpoint is deliberately anonymous: it returns `{"status":"ok"}`
  and does not name the service to anyone who finds the tunnel
- Notion can hold write, terminal and preview tools behind an approval prompt

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

### What is stripped from a command's environment

Until 1.2.0 only `MCP_AUTH_TOKEN` was removed from the environment a child
process inherits. That left `TOKEN_FILE`, `KEYCHAIN_ACCOUNT`,
`KEYCHAIN_SERVICE`, `RUNTIME_ROOT` and `NOTION_COWORK_CONFIG` sitting there —
which is not the token, but is a signposted route to it: `cat "$TOKEN_FILE"`, or
`security find-generic-password -s "$KEYCHAIN_SERVICE" -w`. The whole family now
goes, along with every `MCP_*` and `NGROK_*` variable.

What that buys is narrow and worth stating exactly. An attacker with a shell on
your machine can still find the token; it is in a file or a keychain entry that
your user account can read, and nothing here changes that. What the stripping
removes is the *convenience*, and with it the most likely path to
**persistence**. A stolen bearer token is re-entry that survives you noticing
the intrusion, killing the process, and cleaning the machine — you have to
rotate to close it, and you only rotate if you know. Making the token one step
less obvious is not protection. It is the difference between an attack that
takes one line and one that takes a look around, on the specific asset whose
theft you are least likely to detect.

### What the audit log is and is not

It records what was run. It cannot stop what was run, it is written by the same
process that runs the commands, and anything with your user's permissions can
edit or delete it. It is there so you can answer "what happened" afterwards —
treat it as a flight recorder, not a lock.

Two things narrow that gap since 1.2.0, and neither closes it.

**The chain.** Every record carries `prevHash`, the SHA-256 of the previous line
including its newline. To verify: hash line N, compare with line N+1's
`prevHash`. The chain continues across rotation, so a verifier walks the rotated
files oldest-first. What this buys is that **editing the log becomes
detectable** — change one line and every line after it stops verifying. What it
does not buy is anything at all against someone who rewrites the tail: a process
running as you can recompute the chain from the point it edited onwards and
hand you a log that verifies perfectly. It raises the cost of tampering from
`sed -i` to a short script. It catches careless editing, accidental corruption,
and truncation. It does not catch a competent attacker, and I am not going to
pretend it does.

**The mirror.** Every record is also written to the operating system's own log —
`logger` on macOS, journald on Linux, the Windows Event Log — which a user-level
process can append to but cannot rewrite in place. That is the stronger of the
two, because it puts a second copy somewhere the same process cannot go back and
fix. It is also best effort: it never blocks a tool call and it never throws, so
if `logger` isn't there, the record simply doesn't get mirrored and nothing tells
you. The Windows mirror is a truncated summary, not a second full copy, because
`eventcreate` truncates long descriptions. Compare the two counts if you ever
have reason to; a file with fewer records than the OS log is the interesting
case.

### Failed authentication is now evidence

A 401 used to be silent. It isn't any more: every one writes an `auth.failure`
record with the source address (the ngrok-supplied `X-Forwarded-For` when
present), the path, the user agent, and a running count, and repeated failures
from the same source get an escalating delay up to five seconds. A successful
`initialize` writes `auth.success` with the same fields.

The backoff is not the point. A 64-character token is not going to be guessed,
and the forwarded address is caller-controlled and therefore trivial to vary.
The point is the record. The whole security story of this tunnel is "nobody
knows the URL is there," and until now there was no way to find out that
somebody did. Somebody probing your domain is how you learn the URL leaked —
out of a screenshot, a synced clipboard, a Notion page shared one person too
far — and leaking the URL is the step that comes *before* the one that matters.

```sh
jq -c 'select(.event == "auth.failure")' audit.jsonl
jq -r 'select(.event == "auth.success") | .source' audit.jsonl | sort -u
```

If that second command lists addresses you can't account for, rotate.

## `share_preview` is a real exposure

`share_preview` mounts a reverse proxy at `/preview/<token>/` on the bridge's
own public URL, pointed at one loopback port. It exists because the useful
version of "the agent built something" is a link a human can click, and getting
that link out of Notion any other way is miserable.

It is also the only thing in this project that hands access to someone who has
neither the bearer token nor a shell. **Anyone who ends up with the link reaches
your app with no login.** Links get pasted into Notion pages, forwarded, and
screenshotted.

What you are actually exposing is usually worse than "my app," because what is
usually listening on that port is a development server:

- **Source maps.** Most dev servers serve them by default, which is your
  original source, comments included.
- **`.env` through the bundler.** Vite, Next and friends inline environment
  variables at build time and serve arbitrary disk paths through routes like
  `/@fs/`. A publicly proxied Vite dev server without that route blocked is
  whole-disk read access.
- **Admin and debug routes that assume localhost means trusted.** Django's debug
  toolbar, Rails' `/rails/info`, a seed endpoint, a "reset the database" button
  someone left in because it only ever ran on their laptop.

The mitigations, and what each one is worth:

- **A 128-bit random token in the path**, compared in constant time. It is in
  the path rather than a cookie so it can't leak cross-origin from a stale
  browser session — but a path token appears in browser history, in the
  `Referer` header of any outbound link the page renders, and in any proxy log
  between the visitor and ngrok.
- **A TTL**, 30 minutes by default and 4 hours at most, checked per request
  rather than on a timer so a clock jump can't extend a share. This is the
  mitigation I trust most, because it fixes the failure I actually expect:
  forgetting.
- **`confirm_public: true` is mandatory.** The agent cannot share a port by
  accident or by paraphrase, and the argument's whole job is to make the
  approval prompt you see say what is about to happen.
- **`..` and `/@fs/` are refused**, on both the raw and the percent-decoded
  path, before anything is forwarded. That closes the specific whole-disk hole
  above. It does not close a route your own app serves.
- **Hop-by-hop headers are stripped in both directions**, and **WebSocket
  upgrades are not proxied at all** — so hot reload won't reconnect through a
  preview. That's a real inconvenience and the honest reason for it is that
  proxying upgrades properly is a much larger surface than proxying requests.
- **Every share is audited** on creation, on shutdown, and at most once a minute
  per preview while it is being hit, with the remote address and user agent. Live
  previews also show up in `workspace_info`, so both you and the agent can see
  what is currently exposed.
- **`stop_preview`** revokes one link or all of them, effective on the next
  request, and everything is dropped when the bridge stops.

Every one of those reduces the risk. None of them removes it. The honest summary
is: only share a port you would be comfortable having a stranger poke at for the
length of the TTL, stop it when you're done rather than letting it expire, and
don't point it at anything reading a real database.

## An optional second factor at the edge

The bearer token is the only thing between the internet and the MCP endpoint,
and it travels — into a Notion connection setting, sometimes through a clipboard
or a screenshot on the way. `examples/ngrok-traffic-policy.yml` is a sample ngrok
traffic policy that adds an independent check *before* a request reaches your
machine: anything that doesn't carry a header value you chose gets a 404, so a
scanner that finds your domain never learns there is an MCP server behind it.

```sh
./scripts/bridge install --host <your-domain> \
  --traffic-policy-file ~/.config/notion-cowork-bridge/traffic-policy.yml
```

Then add the same header to the Custom MCP connection in Notion.

This constrains who reaches the door, not what the agent does once inside, which
is why it is compatible with the design rather than a contradiction of it. It is
also a shared secret in a config file, not mTLS — a second thing to know, not a
second kind of proof. Someone who gets both the token and the header is exactly
where they were before.

That's defense in depth. It stops mistakes and narrows the blast radius. It is
not a sandbox.

## How to run this sensibly

For anything beyond personal experimentation on a machine you wouldn't mind
losing:

1. Create a dedicated user account, or use a disposable VM.
2. Give that account only the repositories and credentials it genuinely needs.
3. Keep secrets out of the exposed workspace.
4. Keep terminal, write and preview tools on **Always ask**, and read the
   command before you approve it.
5. Be strict about who can use or reconfigure the Notion agent — sharing the
   agent is sharing the shell.
6. Check Notion's agent activity log from time to time.
7. Stop both services when you aren't using the bridge. It's one command, and it
   removes the exposure entirely.
8. Read the audit log after any session where the agent touched content you did
   not write yourself. Start with `jq 'select(.flagged)'` and
   `jq 'select(.event == "auth.failure")'`.
9. Rotate the token whenever the connection or the token might have been
   exposed: `./scripts/bridge rotate`, or `.\scripts\bridge.ps1 rotate` on
   Windows. `bridge doctor` warns once it is more than 90 days old.
10. `stop_preview` anything you shared as soon as you're done looking at it,
    rather than waiting for the TTL.

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

Two things that are **not** vulnerabilities: an authenticated agent being able
to run arbitrary commands, and a `share_preview` link working for whoever holds
it. Both are the stated purpose, both are in a warning box at the top of the
README, and the first is the first paragraph of this file. A way to bypass the
deny-list isn't one either — see the section above; that is not what it's for.

Things that very much **are**, and that I would want to hear about quickly: a
path that escapes the workspace through a file, search or media tool; a way to
reach a port through the preview proxy other than the one that was shared, or to
read files through it that the app itself doesn't serve; an unauthenticated
request that returns anything about the machine; and anything that gets the
bearer token out of the process.
