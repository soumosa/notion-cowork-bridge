# Contributing

Contributions are welcome when they preserve the project’s explicit security
model and keep installation understandable.

## Development

```sh
npm ci
npm run check
npm test
npm audit --omit=dev
```

Please include tests for behavior changes. Security-sensitive changes should
include the threat being addressed and the case most likely to bypass the fix.

## Pull requests

- Keep changes focused.
- Update documentation when behavior or setup changes.
- Never commit tokens, local paths, tunnel domains, logs, or real workspace
  contents.
- Do not weaken approval guidance or describe the terminal as sandboxed.
- Report observed validation results, not only commands run.
