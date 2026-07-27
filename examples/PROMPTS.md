# Prompt cookbook

These are the prompts I reach for most often. They're deliberately blunt about
what the agent may and may not do, because the tools behind them are real: a
vague prompt here doesn't produce a vague answer, it produces a real command.

Adapt the project-specific bits and keep the constraints.

## Orientation

> Use Local Cowork Bridge. Report the workspace boundary, list the top-level
> files, identify the stack and project commands, and explain the architecture.
> Do not edit anything.

## Implement a bounded feature

> Inspect the relevant files, propose the smallest plan and the check most
> likely to disprove it, then wait for my approval before editing.

## Run a project

> Find the documented setup command, install dependencies, start the project
> only long enough to verify it responds locally, then stop it and report the
> observed URL and status.

## Diagnose without fixing

> Reproduce this issue, identify its most likely cause with file and line
> evidence, and report the smallest credible fix. Do not edit files yet.

## Verify existing work

> Run the project’s full validation command and the edge case most likely to
> fail. Inspect the resulting artifact or runtime state; do not rely only on an
> exit code.

## Git review

> Show the repository status and diff, separate changes related to my request
> from unrelated changes, and flag likely bugs or missing tests. Do not commit
> or push.

## Create a checkpoint

> Verify the work, summarize the diff, and propose a commit message. Wait for
> explicit approval before committing. Never push unless separately asked.

## Dependency work

> Explain which manifest and lockfile will change. Install only the requested
> dependency, run the relevant tests, and report new audit findings.
