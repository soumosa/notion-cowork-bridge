import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";

import httpProxy from "http-proxy";
import * as z from "zod/v4";

import {
  MAX_PREVIEWS,
  NGROK_API_URL,
  PORT,
  PREVIEW_TTL_SECONDS,
} from "../lib/config.js";
import { ERROR_CODES, ToolError, errorResult, textResult } from "../lib/errors.js";

const LOOPBACK = "127.0.0.1";
const PROBE_TIMEOUT_MS = 10_000;
const PROBE_BODY_LIMIT = 64 * 1024;
const MAX_TTL_MINUTES = Math.floor(PREVIEW_TTL_SECONDS / 60);
const AUTH_COOKIE = "__Host-notion_preview";
const AUTH_PATH = "/__notion_preview_auth/";
const BLOCKED_PORTS = new Set([PORT, 4040, 7681, 7682]);
const previews = new Map();

function assertLocalPort(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Port must be an integer between 1 and 65535.", { port });
  }
  if (BLOCKED_PORTS.has(port)) {
    throw new ToolError(ERROR_CODES.DENIED, "That internal control or terminal port is never shareable.", { port });
  }
}
function assertRequestPath(requestPath) {
  if (typeof requestPath !== "string" || !requestPath.startsWith("/") || /[\r\n]/.test(requestPath)) {
    throw new ToolError(ERROR_CODES.INVALID_ARGUMENT, "Path must start with a slash and contain no line breaks.");
  }
  return requestPath;
}

function visibleText(html) {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripHeaders(headers) {
  const blocked = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
  const result = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value !== undefined && !blocked.has(name.toLowerCase())) result[name] = value;
  }
  return result;
}

function compareToken(left, right) {
  const a = Buffer.from(left || "", "utf8");
  const b = Buffer.from(right || "", "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseCookies(value) {
  const result = new Map();
  for (const part of String(value || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return result;
}

function requestLocal({ port, requestPath, method, headers, body }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let finished = false;
    const finish = (value) => {
      if (!finished) {
        finished = true;
        resolve(value);
      }
    };
    const outgoing = httpRequest({
      host: LOOPBACK,
      port,
      path: requestPath,
      method,
      headers: { host: LOOPBACK + ":" + port, ...stripHeaders(headers) },
      timeout: PROBE_TIMEOUT_MS,
    }, (response) => {
      let bodyBuffer = Buffer.alloc(0);
      let truncated = false;
      response.on("data", (chunk) => {
        const remaining = PROBE_BODY_LIMIT - bodyBuffer.length;
        if (remaining <= 0) {
          truncated = true;
          response.destroy();
          finish({
            status: response.statusCode || 0,
            statusText: response.statusMessage || "",
            headers: response.headers,
            body: bodyBuffer,
            truncated,
            durationMs: Date.now() - started,
          });
          return;
        }
        if (chunk.length > remaining) truncated = true;
        bodyBuffer = Buffer.concat([bodyBuffer, chunk.subarray(0, remaining)]);
        if (truncated) response.destroy();
      });
      response.on("end", () => finish({
        status: response.statusCode || 0,
        statusText: response.statusMessage || "",
        headers: response.headers,
        body: bodyBuffer,
        truncated,
        durationMs: Date.now() - started,
      }));
      response.on("close", () => {
        if (truncated) finish({
          status: response.statusCode || 0,
          statusText: response.statusMessage || "",
          headers: response.headers,
          body: bodyBuffer,
          truncated,
          durationMs: Date.now() - started,
        });
      });
      response.on("error", reject);
    });
    outgoing.on("timeout", () => outgoing.destroy(new ToolError(ERROR_CODES.TIMEOUT, "Local request timed out.", { port })));
    outgoing.on("error", (error) => {
      if (error.code === "ECONNREFUSED") reject(new ToolError(ERROR_CODES.NOT_FOUND, "Nothing is listening on the requested loopback port.", { port }));
      else reject(error);
    });
    if (body !== undefined) outgoing.write(body);
    outgoing.end();
  });
}

async function runProbe({ port, requestPath, method, headers, body, mode }) {
  assertLocalPort(port);
  const result = await requestLocal({ port, requestPath: assertRequestPath(requestPath), method, headers, body });
  const utf8 = result.body.toString("utf8");
  return {
    status: result.status,
    statusText: result.statusText,
    durationMs: result.durationMs,
    headers: result.headers,
    redirectTo: result.headers.location || null,
    bodyTruncated: result.truncated,
    body: mode === "raw" ? result.body.toString("base64") : (mode === "html" ? utf8 : visibleText(utf8)),
    encoding: mode === "raw" ? "base64" : "utf8",
  };
}

async function ngrokRequest(path, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(NGROK_API_URL + path, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error("ngrok Agent API returned " + response.status);
    return await response.json();
  } catch (error) {
    throw new ToolError(ERROR_CODES.PREVIEW_UNAVAILABLE, "The local ngrok Agent API is unavailable: " + error.message);
  } finally {
    clearTimeout(timer);
  }
}

class PreviewRelay {
  constructor(id, port, token, expiresAt) {
    this.id = id;
    this.port = port;
    this.token = token;
    this.expiresAt = expiresAt;
    this.publicHost = null;
    this.usedBootstrap = false;
    this.proxy = httpProxy.createProxyServer({ changeOrigin: true, ws: true, proxyTimeout: PROBE_TIMEOUT_MS, timeout: PROBE_TIMEOUT_MS });
    this.proxy.on("proxyRes", (upstream, _request, response) => {
      response.setHeader("referrer-policy", "no-referrer");
      response.setHeader("cache-control", "no-store");
      const location = upstream.headers.location;
      if (location) response.setHeader("location", String(location).replace("http://" + LOOPBACK + ":" + this.port, "https://" + this.publicHost));
      const setCookie = upstream.headers["set-cookie"];
      if (setCookie) {
        const filtered = setCookie.filter((value) => !String(value).startsWith(AUTH_COOKIE + "="));
        if (filtered.length) response.setHeader("set-cookie", filtered);
      }
    });
    this.proxy.on("error", (_error, _request, response) => {
      if (response && !response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
      if (response && response.end) response.end("Preview upstream unavailable");
    });
  }

  async listen() {
    this.server = createServer((request, response) => this.handle(request, response));
    this.server.on("upgrade", (request, socket, head) => this.handleUpgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, LOOPBACK, resolve);
    });
    return this.server.address().port;
  }

  hostAllowed(request) {
    if (!this.publicHost) return true;
    return String(request.headers.host || "").split(":")[0].toLowerCase() === this.publicHost;
  }

  authenticated(request) {
    return compareToken(parseCookies(request.headers.cookie).get(AUTH_COOKIE), this.token);
  }

  handle(request, response) {
    if (!this.hostAllowed(request) || this.expiresAt <= Date.now()) {
      response.writeHead(404, { "referrer-policy": "no-referrer", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    if (request.url === AUTH_PATH + this.token && !this.usedBootstrap) {
      this.usedBootstrap = true;
      const maxAge = Math.max(1, Math.floor((this.expiresAt - Date.now()) / 1000));
      response.writeHead(302, {
        location: "/",
        "set-cookie": AUTH_COOKIE + "=" + this.token + "; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=" + maxAge,
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      });
      response.end();
      return;
    }
    if (!this.authenticated(request)) {
      response.writeHead(404, { "referrer-policy": "no-referrer", "cache-control": "no-store" });
      response.end("Not found");
      return;
    }
    const cookies = parseCookies(request.headers.cookie);
    cookies.delete(AUTH_COOKIE);
    request.headers.cookie = [...cookies].map(([name, value]) => name + "=" + value).join("; ");
    this.proxy.web(request, response, { target: "http://" + LOOPBACK + ":" + this.port });
  }

  handleUpgrade(request, socket, head) {
    if (!this.hostAllowed(request) || this.expiresAt <= Date.now() || !this.authenticated(request)) {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }
    this.proxy.ws(request, socket, head, { target: "http://" + LOOPBACK + ":" + this.port });
  }

  async close() {
    await new Promise((resolve) => this.server.close(resolve));
  }
}

async function stopEntry(ctx, entry) {
  previews.delete(entry.id);
  await ngrokRequest("/api/tunnels/" + encodeURIComponent(entry.tunnelName), { method: "DELETE" }).catch(() => null);
  await entry.relay.close();
  await ctx.audit({ event: "stop_preview.finish", id: entry.id, port: entry.port });
}

export function initPreviewTools(ctx) {
  ctx.addInfo(async () => ({
    activePreviews: [...previews.values()].map((entry) => ({
      id: entry.id,
      port: entry.port,
      createdAt: new Date(entry.createdAt).toISOString(),
      expiresAt: new Date(entry.expiresAt).toISOString(),
    })),
    previewLimit: MAX_PREVIEWS,
  }));
  ctx.onShutdown(async () => {
    await Promise.all([...previews.values()].map((entry) => stopEntry(ctx, entry)));
  });
}

function registerProbe(server, name, methods, annotations, ctx) {
  server.registerTool(name, {
    title: name === "http_probe" ? "Probe a local HTTP service" : "Send a local HTTP request",
    description: "Send one bounded request to a loopback-only port. Redirects are reported rather than followed.",
    inputSchema: {
      port: z.number().int(),
      path: z.string().default("/"),
      method: z.enum(methods).default(methods[0]),
      headers: z.record(z.string(), z.string()).optional(),
      body: z.string().optional(),
      mode: z.enum(["text", "html", "raw"]).default("text"),
    },
    annotations,
  }, async ({ port, path, method, headers, body, mode }) => {
    try {
      const result = await runProbe({ port, requestPath: path, method, headers, body, mode });
      if (name === "http_request") await ctx.audit({ event: "http_request", port, method, path });
      return textResult(result);
    } catch (error) {
      return errorResult(error);
    }
  });
}

export function registerPreviewTools(server, ctx) {
  registerProbe(server, "http_probe", ["GET", "HEAD"], {
    readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
  }, ctx);
  registerProbe(server, "http_request", ["POST", "PUT", "PATCH", "DELETE"], {
    readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
  }, ctx);

  server.registerTool("share_preview", {
    title: "Share a local preview",
    description: "Create a temporary authenticated public endpoint for a loopback app. The link is one-time, expires automatically, and proxies HTTP plus WebSockets at the root path.",
    inputSchema: {
      port: z.number().int(),
      ttl_minutes: z.number().int().min(1).max(MAX_TTL_MINUTES).default(Math.min(30, MAX_TTL_MINUTES)),
      confirm_public: z.literal(true),
      allow_unmanaged: z.boolean().default(false),
    },
    annotations: {
      readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true,
    },
  }, async ({ port, ttl_minutes: ttlMinutes, confirm_public: confirmed, allow_unmanaged: allowUnmanaged }) => {
    try {
      assertLocalPort(port);
      if (!confirmed || !allowUnmanaged) {
        throw new ToolError(ERROR_CODES.DENIED, "Previewing an unmanaged port requires confirm_public: true and allow_unmanaged: true.");
      }
      if (previews.size >= MAX_PREVIEWS) {
        throw new ToolError(ERROR_CODES.BUSY, "The active preview limit has been reached.");
      }
      const id = randomBytes(12).toString("hex");
      const token = randomBytes(16).toString("hex");
      const expiresAt = Date.now() + ttlMinutes * 60_000;
      const relay = new PreviewRelay(id, port, token, expiresAt);
      const relayPort = await relay.listen();
      const tunnelName = "notion-preview-" + id;
      let tunnel;
      try {
        tunnel = await ngrokRequest("/api/tunnels", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: tunnelName, proto: "http", addr: LOOPBACK + ":" + relayPort, inspect: false }),
        });
      } catch (error) {
        await relay.close();
        throw error;
      }
      const publicUrl = new URL(tunnel.public_url);
      relay.publicHost = publicUrl.hostname.toLowerCase();
      const entry = { id, port, relay, tunnelName, createdAt: Date.now(), expiresAt, url: publicUrl.origin + AUTH_PATH + token };
      previews.set(id, entry);
      setTimeout(() => {
        if (previews.get(id) === entry) void stopEntry(ctx, entry);
      }, Math.max(1, expiresAt - Date.now())).unref();
      await ctx.audit({ event: "share_preview.finish", id, port, expiresAt: new Date(expiresAt).toISOString() });
      return {
        content: [
          { type: "text", text: JSON.stringify({ id, url: entry.url, port, createdAt: new Date(entry.createdAt).toISOString(), expiresAt: new Date(expiresAt).toISOString() }, null, 2) },
          { type: "resource_link", uri: entry.url, name: "Preview of port " + port },
        ],
      };
    } catch (error) {
      return errorResult(error);
    }
  });

  server.registerTool("stop_preview", {
    title: "Stop a shared preview",
    description: "Revoke one preview by id or every active preview.",
    inputSchema: { id: z.string().optional() },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  }, async ({ id }) => {
    try {
      const entries = id ? [previews.get(id)].filter(Boolean) : [...previews.values()];
      await Promise.all(entries.map((entry) => stopEntry(ctx, entry)));
      return textResult({ stopped: entries.length, remaining: previews.size });
    } catch (error) {
      return errorResult(error);
    }
  });
}
