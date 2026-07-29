/**
 * The registration barrel. Every tool module lands here and nowhere else, so
 * one file answers "what does this bridge expose".
 *
 * A module exports two things:
 *
 *   registerXTools(server, ctx)  required. Called once per request, because
 *                                the transport is stateless and builds a new
 *                                McpServer for every POST. Register tools and
 *                                nothing else here — no timers, no registries,
 *                                no routes, or you get one of each per call.
 *   initXTools(ctx)              optional. Called once at boot, before the
 *                                HTTP server listens. Long-lived state,
 *                                express routes, shutdown handlers, and
 *                                recovery of anything left over from the last
 *                                run belong here.
 *
 * To add a module: import it, then add one entry below. Order is the order the
 * tools appear to the agent.
 */

import { registerFileTools } from "./files.js";
import { registerSearchTools } from "./search.js";
import { initProcessTools, registerProcessTools } from "./process.js";
import { initPreviewTools, registerPreviewTools } from "./preview.js";
import { registerMediaTools } from "./media.js";
import { initBrowserTools, registerBrowserTools } from "./browser.js";

const TOOL_MODULES = [
  { register: registerFileTools },
  { register: registerSearchTools },
  { init: initProcessTools, register: registerProcessTools },
  { init: initPreviewTools, register: registerPreviewTools },
  { init: initBrowserTools, register: registerBrowserTools },
  { register: registerMediaTools },
];

/** One-time setup for every tool module, before the bridge starts listening. */
export async function initAllTools(ctx) {
  for (const module of TOOL_MODULES) {
    await module.init?.(ctx);
  }
}

/** Per-request tool registration against a fresh McpServer. */
export function registerAllTools(server, ctx) {
  for (const module of TOOL_MODULES) {
    module.register(server, ctx);
  }
}
