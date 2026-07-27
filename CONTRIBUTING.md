# Contributing

Contributions are very welcome, with one condition: they have to preserve the
security model this project states out loud, and they have to keep the install
understandable to someone reading it for the first time. This repository hands a
remote agent a shell. Almost everything else is negotiable; that isn't.

Please also read the [code of conduct](CODE_OF_CONDUCT.md). It's short.

## Getting set up

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

The tests start a real server and need a workspace outside the repo — they check
that the bridge refuses to modify its own files. By default they use two
directories above the repo; set `TEST_WORKSPACE_ROOT` if that doesn't suit your
layout. The Bun test skips itself when Bun isn't installed.

Behavior changes need tests. If you're changing something security-sensitive,
tell me in the pull request what threat you're addressing and what the most
likely way around your fix is. That second part is the useful one, and I'll ask
for it if it's missing.

## Pull requests

- Keep the change focused. One idea per pull request is far easier to review.
- Update the docs when behavior or setup changes. Out-of-date instructions in a
  project like this are a safety problem, not a cosmetic one.
- Never commit tokens, local paths, tunnel domains, logs, or anything out of a
  real workspace.
- Don't soften the approval guidance, and don't describe the terminal as
  sandboxed. It isn't, and someone will believe you.
- Report what you actually observed, not just the commands you ran. "Tests pass"
  and "I ran the tests" are different claims.

Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) while
you're in there.
