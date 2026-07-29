/**
 * Images: reading one back, and making one of a page that is running locally.
 *
 * `read_text_file` refuses anything with a NUL byte in it, which is correct
 * and also means the agent could not read back a single image it had just
 * produced. `read_media_file` is that missing half.
 *
 * `capture_screenshot` deliberately does not bundle a browser. Playwright and
 * Puppeteer are 150-300 MB, and the reason to trust this bridge is that you
 * can read it in an afternoon; the moment auditing it means auditing
 * Chromium, that stops being true. So it looks for a browser you already
 * have, and tells you plainly what to install if you have none. A screenshot
 * is also the most expensive thing you can hand a model — for "is it up, what
 * does it say, what did the API return", `http_probe` is smaller, faster and
 * more informative. Reach for this when the question is genuinely visual.
 */

import { spawn } from "node:child_process";
import { access, constants, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as z from "zod/v4";

import { IS_MACOS, IS_WINDOWS } from "../lib/config.js";
import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";
import { atomicWriteWorkspaceBytes } from "../lib/textfile.js";

const MAX_MEDIA_BYTES = 1024 * 1024;
const SCREENSHOT_TIMEOUT_MS = 45_000;

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

function browserCandidates() {
  const configured = process.env.MCP_SCREENSHOT_BROWSER;
  if (configured) return [configured];
  if (IS_MACOS) {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    ];
  }
  if (IS_WINDOWS) {
    const programFiles = process.env["ProgramFiles"] || "C:\\Program Files";
    const programFilesX86 =
      process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    return [
      path.join(programFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFilesX86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/snap/bin/chromium",
  ];
}

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next one; a missing browser is normal, not an error.
    }
  }
  return null;
}

function runBrowser(ctx, browser, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(browser, args, {
      stdio: ["ignore", "ignore", "pipe"],
      detached: !ctx.isWindows,
      windowsHide: true,
      env: ctx.shell.environment(),
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk;
    });
    const timer = setTimeout(() => {
      try {
        if (!ctx.isWindows) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
      reject(
        new ToolError(
          ERROR_CODES.TIMEOUT,
          `The browser did not finish within ${SCREENSHOT_TIMEOUT_MS}ms.`,
        ),
      );
    }, SCREENSHOT_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
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
        destructiveHint: true,
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
        destructiveHint: false,
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

        const browser = await findBrowser();
        if (!browser) {
          throw new ToolError(
            ERROR_CODES.UNSUPPORTED,
            "No browser found. Install Google Chrome, Chromium or Edge, or set MCP_SCREENSHOT_BROWSER to the path of one.",
            { looked: browserCandidates() },
          );
        }

        const url = `http://127.0.0.1:${port}${requestPath}`;
        const temporaryDir = await mkdtemp(path.join(tmpdir(), "notion-cowork-shot-"));
        const temporaryPng = path.join(temporaryDir, "capture.png");
        await ctx.audit({
          event: "capture_screenshot.start",
          port,
          path: ctx.paths.workspaceRelative(target),
        });

        try {
          const { code, stderr } = await runBrowser(ctx, browser, [
            "--headless=new",
            "--disable-gpu",
            "--hide-scrollbars",
            `--user-data-dir=${temporaryDir}`,
            `--window-size=${width},${height}`,
            `--screenshot=${temporaryPng}`,
            url,
          ]);
          if (code !== 0) {
            throw new ToolError(
              ERROR_CODES.INTERNAL,
              `The browser exited with code ${code}. ${stderr.trim().slice(0, 500)}`,
              { port, url },
            );
          }
          const image = await readFile(temporaryPng);
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
            { port, url },
          );
        } finally {
          await rm(temporaryDir, { recursive: true, force: true });
        }
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
