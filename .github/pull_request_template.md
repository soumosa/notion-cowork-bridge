## Summary

What's the smallest behavior change here, and why is it needed?

## Security impact

Anything that touches authentication, the file boundary, terminal access,
service installation, or secret handling. If it touches none of those, say so
explicitly — that's a useful answer too.

## Verification

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm audit --omit=dev`
- [ ] I tested the case most likely to break or bypass this change, and I've
      described what I observed above.
- [ ] Docs and `CHANGELOG.md` updated, if behavior or setup changed.
