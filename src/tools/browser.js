import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";
import * as z from "zod/v4";

import {
  BROWSER_IDLE_SECONDS,
  BROWSER_TTL_SECONDS,
  MAX_BROWSER_SESSIONS,
} from "../lib/config.js";
import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";

const MAX_CONSOLE_ENTRIES = 1000;
const MAX_SNAPSHOT_ITEMS = 200;
const MAX_SCREENSHOT_BYTES = 1024 * 1024;
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const BLOCKED_PORTS = new Set([3210, 4040, 7681, 7682]);
const sessions = new Map();

function browserCandidates() {
  if (process.env.MCP_BROWSER_PATH) return [process.env.MCP_BROWSER_PATH];
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  }
  if (process.platform === "win32") {
    const programs = process.env.ProgramFiles || "C:\\Program Files";
    return [
      path.join(programs, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(programs, "Microsoft", "Edge", "Application", "msedge.exe"),
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"];
}

async function findBrowser() {
  for (const candidate of browserCandidates()) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next installed browser.
    }
  }
  return null;
}

function isLoopbackUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:") return false;
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return false;
    const port = Number(url.port || 80);
    return !BLOCKED_PORTS.has(port);
  } catch {
    return false;
  }
}

function pushBounded(items, item) {
  items.push(item);
  if (items.length > MAX_CONSOLE_ENTRIES) items.splice(0, items.length - MAX_CONSOLE_ENTRIES);
}

function sessionFor(id) {
  const session = sessions.get(id);
  if (!session) throw new ToolError(ERROR_CODES.NOT_FOUND, "No browser session with that id.", { session_id: id });
  if (session.expiresAt <= Date.now() || session.lastUsed + BROWSER_IDLE_SECONDS * 1000 <= Date.now()) {
    void closeSession(session);
    throw new ToolError(ERROR_CODES.NOT_FOUND, "Browser session expired.", { session_id: id });
  }
  session.lastUsed = Date.now();
  return session;
}

async function closeSession(session) {
  sessions.delete(session.id);
  await session.context.close().catch(() => {});
  await rm(session.profileDir, { recursive: true, force: true }).catch(() => {});
}

async function elementFor(session, ref) {
  const handle = session.refs.get(ref);
  const connected = handle
    ? await handle.evaluate((element) => element.isConnected).catch(() => false)
    : false;
  if (!connected) {
    throw new ToolError(ERROR_CODES.STALE_REF, "Element reference is stale. Call browser_snapshot again.", { ref });
  }
  return handle;
}

async function snapshot(session) {
  session.refs.clear();
  const handles = await session.page.locator("a,button,input,textarea,select,[role=button],[role=link],[contenteditable=true]").elementHandles();
  const entries = [];
  for (const handle of handles.slice(0, MAX_SNAPSHOT_ITEMS)) {
    const data = await handle.evaluate((element) => ({
      tag: element.tagName.toLowerCase(),
      text: (element.innerText || element.getAttribute("aria-label") || element.getAttribute("placeholder") || "").trim().slice(0, 500),
      role: element.getAttribute("role") || null,
      type: element.getAttribute("type") || null,
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
    })).catch(() => null);
    if (!data) continue;
    const ref = "e" + randomBytes(6).toString("hex");
    session.refs.set(ref, handle);
    entries.push({ ref, ...data });
  }
  return {
    session_id: session.id,
    url: session.page.url(),
    title: await session.page.title(),
    items: entries,
    truncated: handles.length > MAX_SNAPSHOT_ITEMS,
  };
}

async function launchLoopbackPage(ctx, { port, requestPath, width, height }) {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || BLOCKED_PORTS.has(port)) {
    throw new ToolError(ERROR_CODES.DENIED, "Browser navigation may only target an allowed loopback app port.", { port });
  }
  if (!requestPath.startsWith("/")) throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Path must start with a slash.");
  const executablePath = await findBrowser();
  if (!executablePath) {
    throw new ToolError(ERROR_CODES.BROWSER_UNAVAILABLE, "No supported Chrome, Chromium, or Edge executable was found.", { candidates: browserCandidates() });
  }
  const profileDir = await mkdtemp(path.join(tmpdir(), "notion-cowork-browser-"));
  let context;
  let page;
  const url = "http://127.0.0.1:" + port + requestPath;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      executablePath,
      headless: true,
      viewport: { width, height },
      env: ctx.shell.environment(),
      args: ["--no-first-run", "--no-default-browser-check", "--disable-extensions"],
    });
    page = context.pages()[0] || await context.newPage();
    await page.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !isLoopbackUrl(request.url())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (!isLoopbackUrl(page.url())) {
      throw new ToolError(
        ERROR_CODES.DENIED,
        "Browser navigation left the allowed loopback app.",
        { url: page.url() },
      );
    }
    return { context, page, profileDir, url, executablePath };
  } catch (error) {
    await context?.close().catch(() => {});
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    if (error instanceof ToolError) throw error;
    throw new ToolError(ERROR_CODES.NOT_FOUND, "Browser could not load the loopback page: " + error.message, { url });
  }
}

export async function captureLoopbackScreenshot(ctx, options) {
  const launched = await launchLoopbackPage(ctx, options);
  try {
    const image = await launched.page.screenshot({
      type: "png",
      fullPage: false,
      timeout: 30_000,
    });
    return {
      image,
      url: launched.page.url(),
      browser: launched.executablePath,
    };
  } finally {
    await launched.context.close().catch(() => {});
    await rm(launched.profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function openBrowser(ctx, options) {
  if (sessions.size >= MAX_BROWSER_SESSIONS) {
    throw new ToolError(ERROR_CODES.BUSY, "The active browser-session limit has been reached.");
  }
  const { context, page, profileDir, executablePath } = await launchLoopbackPage(ctx, options);
  const id = randomBytes(12).toString("hex");
  const session = {
    id,
    page,
    context,
    profileDir,
    refs: new Map(),
    console: [],
    network: [],
    externalOrigins: new Set(),
    createdAt: Date.now(),
    lastUsed: Date.now(),
    expiresAt: Date.now() + BROWSER_TTL_SECONDS * 1000,
  };
  page.on("console", (message) => pushBounded(session.console, {
    cursor: session.console.length ? session.console.at(-1).cursor + 1 : 1,
    time: new Date().toISOString(),
    type: message.type(),
    text: message.text().slice(0, 4000),
  }));
  page.on("requestfailed", (request) => pushBounded(session.network, {
    cursor: session.network.length ? session.network.at(-1).cursor + 1 : 1,
    time: new Date().toISOString(),
    url: request.url(),
    failure: request.failure()?.errorText || "failed",
  }));
  page.on("response", (response) => {
    try {
      const url = new URL(response.url());
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) session.externalOrigins.add(url.origin);
      pushBounded(session.network, {
        cursor: session.network.length ? session.network.at(-1).cursor + 1 : 1,
        time: new Date().toISOString(),
        url: response.url(),
        status: response.status(),
      });
    } catch {
      // Ignore non-URL protocol entries.
    }
  });
  sessions.set(id, session);
  await ctx.audit({ event: "browser.open", sessionId: id, port: options.port, path: options.requestPath });
  return { session_id: id, url: page.url(), title: await page.title(), browser: executablePath };
}

function cursorSlice(items, cursor, limit) {
  return items.filter((item) => item.cursor > (cursor || 0)).slice(-limit);
}

export function initBrowserTools(ctx) {
  const timer = setInterval(() => {
    for (const session of sessions.values()) {
      if (session.expiresAt <= Date.now() || session.lastUsed + BROWSER_IDLE_SECONDS * 1000 <= Date.now()) void closeSession(session);
    }
  }, 30_000);
  timer.unref();
  ctx.addInfo(async () => ({
    browserAvailable: Boolean(await findBrowser()),
    browserSessionLimit: MAX_BROWSER_SESSIONS,
    activeBrowserSessions: sessions.size,
  }));
  ctx.onShutdown(async () => {
    clearInterval(timer);
    await Promise.all([...sessions.values()].map((session) => closeSession(session)));
  });
}

export function registerBrowserTools(server, ctx) {
  server.registerTool("browser_status", {
    title: "Browser status",
    description: "Show browser availability and active isolated sessions.",
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async () => textResult({
    available: Boolean(await findBrowser()),
    activeSessions: [...sessions.values()].map((session) => ({ id: session.id, createdAt: new Date(session.createdAt).toISOString(), expiresAt: new Date(session.expiresAt).toISOString() })),
  }));

  server.registerTool("browser_open", {
    title: "Open a local app in an isolated browser",
    description: "Open an allowed loopback page in an ephemeral browser profile. Top-level navigation outside loopback is blocked.",
    inputSchema: {
      port: z.number().int(),
      path: z.string().default("/"),
      width: z.number().int().min(200).max(3840).default(1280),
      height: z.number().int().min(200).max(2160).default(800),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ port, path, width, height }) => {
    try {
      return textResult(await openBrowser(ctx, { port, requestPath: path, width, height }));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("browser_snapshot", {
    title: "Inspect the current browser page",
    description: "Return bounded interactive page elements with opaque references for browser_interact.",
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id: id }) => {
    try {
      return textResult(await snapshot(sessionFor(id)));
    } catch (error) {
      return errorResult(error);
    }
  });

  for (const [name, source] of [["browser_console", "console"], ["browser_network", "network"]]) {
    server.registerTool(name, {
      title: name === "browser_console" ? "Read browser console messages" : "Read browser network events",
      description: "Read bounded diagnostic events without response bodies, cookies, or authorization headers.",
      inputSchema: { session_id: z.string().min(1), cursor: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(1000).default(200) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ session_id: id, cursor, limit }) => {
      try {
        const session = sessionFor(id);
        return textResult({
          cursor: session[source].length ? session[source].at(-1).cursor : 0,
          events: cursorSlice(session[source], cursor, limit),
          externalOrigins: source === "network" ? [...session.externalOrigins] : undefined,
        });
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  server.registerTool("browser_screenshot", {
    title: "Capture the current browser page",
    description: "Return a PNG image of the current isolated browser page without writing a workspace file.",
    inputSchema: { session_id: z.string().min(1), full_page: z.boolean().default(false) },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id: id, full_page: fullPage }) => {
    try {
      const image = await sessionFor(id).page.screenshot({ type: "png", fullPage });
      if (image.length > MAX_SCREENSHOT_BYTES) throw new ToolError(ERROR_CODES.TOO_LARGE, "Browser screenshot exceeds the 1 MiB response limit.");
      return { content: [{ type: "image", data: image.toString("base64"), mimeType: "image/png" }] };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("browser_interact", {
    title: "Interact with the current browser page",
    description: "Click, type, fill, select, press keys, scroll, or wait using references returned by browser_snapshot.",
    inputSchema: {
      session_id: z.string().min(1),
      action: z.enum(["click", "type", "fill", "select", "press", "scroll", "wait"]),
      ref: z.string().optional(),
      text: z.string().optional(),
      fields: z.array(z.object({ ref: z.string().min(1), text: z.string() })).min(1).optional(),
      value: z.string().optional(),
      key: z.string().optional(),
      clear: z.boolean().default(true),
      dx: z.number().default(0),
      dy: z.number().default(0),
      timeout_ms: z.number().int().min(1).max(30_000).default(10_000),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const session = sessionFor(args.session_id);
      if (args.action === "scroll") await session.page.mouse.wheel(args.dx, args.dy);
      else if (args.action === "wait") await session.page.waitForTimeout(args.timeout_ms);
      else if (args.action === "fill" && args.fields) {
        for (const field of args.fields) {
          await (await elementFor(session, field.ref)).fill(field.text, { timeout: args.timeout_ms });
        }
      } else {
        if (!args.ref) throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "This interaction needs a snapshot reference.");
        const element = await elementFor(session, args.ref);
        if (args.action === "click") await element.click({ timeout: args.timeout_ms });
        if (args.action === "type") {
          if (args.clear) await element.fill("", { timeout: args.timeout_ms });
          await element.type(args.text || "", { timeout: args.timeout_ms });
        }
        if (args.action === "fill") await element.fill(args.text || "", { timeout: args.timeout_ms });
        if (args.action === "select") await element.selectOption(args.value || "", { timeout: args.timeout_ms });
        if (args.action === "press") await element.press(args.key || "Enter", { timeout: args.timeout_ms });
      }
      await ctx.audit({ event: "browser.interact", sessionId: session.id, action: args.action, ref: args.ref || null });
      return textResult(await snapshot(session));
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("browser_eval", {
    title: "Evaluate page JavaScript",
    description: "Run bounded JavaScript inside the current page only. It cannot access Node.js or the bridge filesystem.",
    inputSchema: { session_id: z.string().min(1), script: z.string().min(1).max(20_000) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ session_id: id, script }) => {
    try {
      const value = await sessionFor(id).page.evaluate((source) => {
        let expression;
        try {
          expression = Function("return (" + source + "\n)");
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          return Function(source)();
        }
        return expression();
      }, script);
      const serialized = JSON.stringify(value) ?? "null";
      if (Buffer.byteLength(serialized, "utf8") > 256 * 1024) throw new ToolError(ERROR_CODES.TOO_LARGE, "Evaluation result exceeds the 256 KiB limit.");
      await ctx.audit({ event: "browser.eval", sessionId: id, scriptSha256: createHash("sha256").update(script).digest("hex") });
      return textResult({ value });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("browser_upload", {
    title: "Upload a workspace file through the browser",
    description: "Attach a symlink-safe workspace file to a file input identified by browser_snapshot.",
    inputSchema: { session_id: z.string().min(1), ref: z.string().min(1), path: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  }, async ({ session_id: id, ref, path: userPath }) => {
    try {
      const target = await ctx.paths.resolveExistingPath(userPath);
      const info = await stat(target);
      if (!info.isFile() || info.size > MAX_UPLOAD_BYTES) throw new ToolError(ERROR_CODES.TOO_LARGE, "Upload must be a regular workspace file no larger than 25 MiB.");
      const session = sessionFor(id);
      await (await elementFor(session, ref)).setInputFiles(target);
      await ctx.audit({ event: "browser.upload", sessionId: id, path: ctx.paths.workspaceRelative(target), bytes: info.size });
      return textResult({ uploaded: ctx.paths.workspaceRelative(target), bytes: info.size });
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("browser_close", {
    title: "Close an isolated browser session",
    description: "Close one ephemeral browser session and delete its temporary profile.",
    inputSchema: { session_id: z.string().min(1) },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async ({ session_id: id }) => {
    try {
      const session = sessionFor(id);
      await closeSession(session);
      await ctx.audit({ event: "browser.close", sessionId: id });
      return textResult({ closed: id });
    } catch (error) {
      return errorResult(error);
    }
  });
}
