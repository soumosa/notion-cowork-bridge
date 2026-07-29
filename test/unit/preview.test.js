import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

process.env.MCP_AUTH_TOKEN = "unit-test-token-0123456789-0123456789";
const previewWorkspace = mkdtempSync(path.join(tmpdir(), "notion-preview-unit-"));
process.env.MCP_WORKSPACE_ROOT = previewWorkspace;

const {
  isForbiddenPreviewPath,
  isReservedBridgePath,
} = await import("../../src/tools/preview.js");

test("preview paths reject raw and percent-encoded traversal plus Vite filesystem routes", () => {
  for (const requestPath of [
    "/../secret",
    "/%2e%2e/secret",
    "/%252e%252e/secret",
    "/%40fs/private/file",
    "/%2540fs/private/file",
    "/%E0%A4%A",
  ]) {
    assert.equal(isForbiddenPreviewPath(requestPath), true, requestPath);
  }
  assert.equal(isForbiddenPreviewPath("/assets/main.js?next=/../not-a-path"), false);
  assert.equal(isForbiddenPreviewPath("/assets/main.js"), false);
});

test("Vite filesystem routes are limited to real files inside the workspace", () => {
  const inside = path.join(previewWorkspace, "generated-client.js");
  const outsideDirectory = mkdtempSync(path.join(tmpdir(), "notion-preview-outside-"));
  const outside = path.join(outsideDirectory, "secret.txt");
  writeFileSync(inside, "export {};\n");
  writeFileSync(outside, "secret\n");

  const vitePath = (target) =>
    `/@fs/${target.replaceAll("\\", "/").replace(/^\/+/, "")}`;
  assert.equal(isForbiddenPreviewPath(vitePath(inside)), false);
  assert.equal(isForbiddenPreviewPath(vitePath(outside)), true);

  if (process.platform !== "win32") {
    const link = path.join(previewWorkspace, "outside-link.txt");
    symlinkSync(outside, link);
    assert.equal(isForbiddenPreviewPath(vitePath(link)), true);
  }
});

test("same-host previews never own bridge routes", () => {
  for (const requestPath of [
    "/mcp",
    "/mcp/",
    "/mcp/session",
    "/health",
    "/health/details",
  ]) {
    assert.equal(isReservedBridgePath(requestPath), true, requestPath);
  }
  assert.equal(isReservedBridgePath("/mcp-app"), false);
  assert.equal(isReservedBridgePath("/healthy"), false);
});
