/**
 * Tool results, and the error codes that go with them.
 *
 * An agent cannot branch on an English sentence, so every failure carries a
 * stable code as well as the message. The codes are a contract: add to the
 * list, never rename or repurpose an existing one.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENT: "E_INVALID_ARGUMENT",
  INVALID_PATH: "E_INVALID_PATH",
  OUTSIDE_WORKSPACE: "E_OUTSIDE_WORKSPACE",
  PROTECTED_PATH: "E_PROTECTED_PATH",
  NOT_FOUND: "E_NOT_FOUND",
  EXISTS: "E_EXISTS",
  NOT_A_FILE: "E_NOT_A_FILE",
  NOT_A_DIRECTORY: "E_NOT_A_DIRECTORY",
  IS_DIRECTORY: "E_IS_DIRECTORY",
  IS_SYMLINK: "E_IS_SYMLINK",
  BINARY: "E_BINARY",
  TOO_LARGE: "E_TOO_LARGE",
  PRECONDITION_FAILED: "E_PRECONDITION_FAILED",
  CONFLICT: "E_CONFLICT",
  BUSY: "E_BUSY",
  TIMEOUT: "E_TIMEOUT",
  PERMISSION: "E_PERMISSION",
  DENIED: "E_DENIED",
  UNSUPPORTED: "E_UNSUPPORTED",
  SEARCH_TIMEOUT: "E_SEARCH_TIMEOUT",
  OUTPUT_LIMIT: "E_OUTPUT_LIMIT",
  PREVIEW_UNAVAILABLE: "E_PREVIEW_UNAVAILABLE",
  BROWSER_UNAVAILABLE: "E_BROWSER_UNAVAILABLE",
  STALE_REF: "E_STALE_REF",
  INTERNAL: "E_INTERNAL",
});

/**
 * The only error type a tool should throw on purpose. Anything else is a bug
 * or an operating-system failure and gets mapped below.
 */
export class ToolError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }

  toPayload() {
    return { code: this.code, message: this.message, ...this.details };
  }
}

// Operating-system failures the tools hit routinely. Everything else is
// reported as internal, because guessing is worse than saying so.
const NODE_ERROR_CODES = new Map([
  ["ENOENT", ERROR_CODES.NOT_FOUND],
  ["EEXIST", ERROR_CODES.EXISTS],
  ["ENOTDIR", ERROR_CODES.NOT_A_DIRECTORY],
  ["EISDIR", ERROR_CODES.IS_DIRECTORY],
  ["ELOOP", ERROR_CODES.IS_SYMLINK],
  ["EACCES", ERROR_CODES.PERMISSION],
  ["EPERM", ERROR_CODES.PERMISSION],
  ["ENAMETOOLONG", ERROR_CODES.INVALID_PATH],
  ["ENOSPC", ERROR_CODES.INTERNAL],
]);

export function asToolError(error) {
  if (error instanceof ToolError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const code = NODE_ERROR_CODES.get(error?.code) || ERROR_CODES.INTERNAL;
  return new ToolError(code, message);
}

export function textResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** Turns anything thrown by a tool into an MCP error result with a code. */
export function errorResult(error) {
  return {
    isError: true,
    content: [
      { type: "text", text: JSON.stringify(asToolError(error).toPayload(), null, 2) },
    ],
  };
}
