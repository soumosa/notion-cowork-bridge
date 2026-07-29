import assert from "node:assert/strict";
import { test } from "node:test";

process.env.MCP_AUTH_TOKEN = "unit-test-token-0123456789-0123456789";

const { isForbiddenPreviewPath } = await import("../../src/tools/preview.js");

test("preview paths reject raw and percent-encoded traversal plus Vite filesystem routes", () => {
  for (const requestPath of [
    "/../secret",
    "/%2e%2e/secret",
    "/%252e%252e/secret",
    "/@fs/private/file",
    "/%40fs/private/file",
    "/%E0%A4%A",
  ]) {
    assert.equal(isForbiddenPreviewPath(requestPath), true, requestPath);
  }
  assert.equal(isForbiddenPreviewPath("/assets/main.js?next=/../not-a-path"), false);
  assert.equal(isForbiddenPreviewPath("/assets/main.js"), false);
});
