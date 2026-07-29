/**
 * Images: reading one back, and making one of a page that is running locally.
 *
 * `read_text_file` refuses anything with a NUL byte in it, which is correct
 * and also means the agent could not read back a single image it had just
 * produced. `read_media_file` is that missing half.
 *
 * `capture_screenshot` uses the same isolated Playwright manager as the
 * interactive browser tools, backed by a browser already installed on the
 * host. A screenshot is also the most expensive thing you can hand a model —
 * for "is it up, what does it say, what did the API return", `http_probe` is
 * smaller, faster and more informative. Reach for this when the question is
 * genuinely visual.
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as z from "zod/v4";

import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";
import { atomicWriteWorkspaceBytes } from "../lib/textfile.js";
import { captureLoopbackScreenshot } from "./browser.js";

const MAX_MEDIA_BYTES = 1024 * 1024;

const MEDIA_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"],
]);

// What the bytes actually are, which is not always what the name claims.
const MAGIC = [
  { type: "image/png", bytes: [0x89, 0x50, 0x4e, 0x47] },
  { type: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { type: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { type: "image/bmp", bytes: [0x42, 0x4d] },
];

function sniffMediaType(buffer, extension) {
  for (const candidate of MAGIC) {
    if (candidate.bytes.every((byte, index) => buffer[index] === byte)) {
      return candidate.type;
    }
  }
  if (buffer.subarray(0, 12).toString("ascii").includes("WEBP")) return "image/webp";
  return MEDIA_TYPES.get(extension) || null;
}

export function registerMediaTools(server, ctx) {
  server.registerTool(
    "read_media_file",
    {
      title: "Read an image from the workspace",
      description:
        "Read an image file from the workspace and return it as an image. Use this for screenshots and other pictures; read_text_file refuses them because they contain NUL bytes.",
      inputSchema: {
        path: z.string().describe("Workspace-relative path to the image."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ path: userPath }) => {
      try {
        const target = await ctx.paths.resolveExistingPath(userPath);
        const info = await stat(target);
        if (!info.isFile()) {
          throw new ToolError(
            ERROR_CODES.NOT_A_FILE,
            "The requested path is not a regular file.",
            { path: ctx.paths.workspaceRelative(target) },
          );
        }
        if (info.size > MAX_MEDIA_BYTES) {
          throw new ToolError(
            ERROR_CODES.TOO_LARGE,
            `Image exceeds the ${MAX_MEDIA_BYTES}-byte limit. Images are expensive to send; resize it first.`,
            { path: ctx.paths.workspaceRelative(target), size: info.size },
          );
        }

        const buffer = await readFile(target);
        const mimeType = sniffMediaType(buffer, path.extname(target).toLowerCase());
        if (!mimeType) {
          throw new ToolError(
            ERROR_CODES.UNSUPPORTED,
            "That file is not an image this tool recognises.",
            { path: ctx.paths.workspaceRelative(target) },
          );
        }

        return {
          content: [{ type: "image", data: buffer.toString("base64"), mimeType }],
        };
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "capture_screenshot",
    {
      title: "Screenshot a locally running page",
      description:
        "Render a page served on this machine's loopback interface and save it into the workspace as a PNG, then read it back with read_media_file. Needs Chrome, Chromium or Edge already installed; it does not install one. For checking whether something works, http_probe is cheaper and tells you more — use this when the question is about how it looks.",
      inputSchema: {
        port: z.number().int().min(1).max(65535).describe("The loopback port to render."),
        path: z.string().default("/").describe("Request path, starting with a slash."),
        output_path: z
          .string()
          .default("screenshot.png")
          .describe("Workspace-relative destination for the PNG."),
        width: z.number().int().min(200).max(3840).default(1280),
        height: z.number().int().min(200).max(2160).default(800),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ port, path: requestPath, output_path: outputPath, width, height }) => {
      try {
        if (!requestPath.startsWith("/")) {
          throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Path must start with a slash.", {
            path: requestPath,
          });
        }
        const target = ctx.paths.resolveWorkspacePath(outputPath);
        await ctx.paths.assertWritableTarget(target);
        await ctx.paths.assertNoSymlinkSegments(path.dirname(target));
        await ctx.paths.assertNoSymlinkSegments(target, { allowMissingLeaf: true });

        await ctx.audit({
          event: "capture_screenshot.start",
          port,
          path: ctx.paths.workspaceRelative(target),
        });

        try {
          const { image, url, browser } = await captureLoopbackScreenshot(ctx, {
            port,
            requestPath,
            width,
            height,
          });
          if (image.length === 0) {
            throw new ToolError(ERROR_CODES.INTERNAL, "The browser wrote an empty screenshot.", { port, url });
          }
          const write = await atomicWriteWorkspaceBytes(ctx.paths, target, image);
          const size = write.bytesWritten;
          await ctx.audit({
            event: "capture_screenshot.finish",
            port,
            path: ctx.paths.workspaceRelative(target),
            bytes: size,
          });
          return textResult({
            path: ctx.paths.workspaceRelative(target),
            bytes: size,
            sha256: write.sha256,
            url,
            browser,
            next: "Call read_media_file on that path to look at it.",
          });
        } catch (error) {
          if (error instanceof ToolError) throw error;
          throw new ToolError(
            ERROR_CODES.INTERNAL,
            "The browser wrote no fresh screenshot: " + error.message,
            { port },
          );
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
