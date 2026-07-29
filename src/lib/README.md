# The shared library, and the contract a tool module signs

Six modules, no framework. Read this before adding a tool; you should not need
to read `server.js` to write one.

| File | Budget | What lives there |
| --- | --- | --- |
| `config.js` | ~150 | environment parsing, every limit constant, `stateDir()`, `resolveShell()`, `shellArguments()`, `commandEnvironment()` |
| `paths.js` | ~180 | the workspace boundary: `assertPortableRelativePath`, `isInside`, path resolution, per-segment symlink guards |
| `audit.js` | ~190 | `audit()`, the hash chain, rotation, the OS-log mirror |
| `errors.js` | ~90 | `ToolError`, the stable error codes, `textResult`, `errorResult` |
| `globs.js` | ~90 | `DEFAULT_IGNORE_NAMES`, `globToRegExp`, `loadGitignorePatterns`, `matchesAnyPattern` - the ignore-list logic `list_files`, `search_text` and `glob_files` all share |
| `textfile.js` | ~350 | `scanLines`, `atomicWriteWorkspaceFile`, `assertMatchesSha256` and the exact-string diff engine (`applyEdits` and friends) behind `read_text_file`/`write_text_file`/`edit_text_file` |

`src/tools/index.js` (~40) is the registration barrel. `src/server.js` (~400)
is bootstrap, express, auth, transport and shutdown.

## Registering a tool module

```js
export function initFileTools(ctx) {}            // optional, once at boot
export function registerFileTools(server, ctx) {} // required, once per request
```

Add the module to `TOOL_MODULES` in `src/tools/index.js`; nothing else imports
it.

`registerXTools` runs **once per HTTP request**. The transport is stateless, so
every POST builds a fresh `McpServer`. Register tools there and nothing else:
a timer, a registry, an express route or a `Map` created inside it is created
again on every call. Long-lived state goes in module scope or in `initXTools`,
which runs once, before the server starts listening.

## `ctx`

```js
ctx.version                 // from package.json, the one source of the version
ctx.platform                // process.platform
ctx.isWindows
ctx.workspaceRoot           // absolute, already resolved
ctx.controlRoot             // the bridge's own files; never writable
ctx.stateDir                // logs and other state the user does not edit
ctx.auditPath
ctx.limits                  // maxReadBytes, maxWriteBytes, maxCommandOutputBytes,
                            // maxCommandTimeoutMs, maxListEntries, jsonBodyLimitBytes
ctx.shell                   // { path, argumentsFor(shell, command), environment() }
ctx.paths                   // the paths.js exports, so a tool never resolves a path itself
ctx.audit(record)           // resolves when the record is on disk; never throws
ctx.app                     // the one express app; mount routes from initXTools only
ctx.addInfo(async () => ({…}))  // extra fields merged into workspace_info
ctx.onShutdown(async (signal) => {…})  // runs before the HTTP server closes
```

Anything an agent can reach must go through `ctx.paths`. `resolveWorkspacePath`
for a target that may not exist yet, `resolveExistingPath` for one that must,
`assertWritableTarget` before any write, `assertNoSymlinkSegments` when you
resolve a parent yourself. Never hand a user-supplied string to `fs`.

## Errors

Throw `ToolError`, catch at the tool boundary, return `errorResult(error)`. The
error content block is JSON, so the agent can branch on the code instead of
parsing English:

```js
throw new ToolError(ERROR_CODES.TOO_LARGE, `File exceeds the ${limit}-byte read limit.`, { path });
// → { "code": "E_TOO_LARGE", "message": "File exceeds the …", "path": "notes.txt" }
```

`errorResult` maps anything else it is given: `ENOENT` becomes `E_NOT_FOUND`,
`EEXIST` `E_EXISTS`, `EACCES`/`EPERM` `E_PERMISSION`, `ENOTDIR`
`E_NOT_A_DIRECTORY`, `EISDIR` `E_IS_DIRECTORY`, `ELOOP` `E_IS_SYMLINK`, and
everything unrecognised `E_INTERNAL`.

The codes: `E_INVALID_ARGUMENT`, `E_INVALID_PATH`, `E_OUTSIDE_WORKSPACE`,
`E_PROTECTED_PATH`, `E_NOT_FOUND`, `E_EXISTS`, `E_NOT_A_FILE`,
`E_NOT_A_DIRECTORY`, `E_IS_DIRECTORY`, `E_IS_SYMLINK`, `E_BINARY`,
`E_TOO_LARGE`, `E_PRECONDITION_FAILED`, `E_CONFLICT`, `E_BUSY`, `E_TIMEOUT`,
`E_PERMISSION`, `E_DENIED`, `E_UNSUPPORTED`, `E_INTERNAL`.

They are a contract. Add to the list; never rename one and never repurpose one.

## Audit

**Every consequential tool writes `<tool>.start` before it acts and
`<tool>.finish` after.** This is the most important invariant in the codebase.
A command that hangs, a process that is SIGKILLed and a machine that loses
power all leave the start record behind, which is the whole reason the log is
worth having. A tool that logs only on success is invisible exactly when it
matters.

```js
await ctx.audit({ event: "edit_text_file.start", path, edits: edits.length });
// … do the thing …
await ctx.audit({ event: "edit_text_file.finish", path, bytesWritten, durationMs });
```

Read-only tools do not need records. Anything that writes, deletes, spawns,
kills or exposes something to the network does.

Never put the bearer token, a file's contents or a secret in a record. Paths are
workspace-relative. Every record carries `prevHash`, the SHA-256 of the previous
line including its newline, so verification is: hash line N, compare with line
N+1's `prevHash`. The chain continues across rotation (10 MB, five files kept),
so a verifier walks the rotated files oldest-first.
