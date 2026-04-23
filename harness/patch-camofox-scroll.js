#!/usr/bin/env node
/**
 * Patch the installed @askjo/camofox-browser plugin to fix scrolling.
 * Playwright's mouse.wheel() does not work in Firefox/Camoufox because
 * the wheel event is not tied to a positioned mouse cursor. We replace
 * it with JavaScript-based window.scrollBy() which is reliable.
 * This is idempotent — safe to run multiple times.
 */

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_DIR = path.join(
  process.env.HOME || "/Users/leonl",
  ".openclaw",
  "extensions",
  "camofox-browser"
);
const SERVER_FILE = path.join(PLUGIN_DIR, "server.js");

function log(msg) {
  console.log(`[patch-camofox-scroll] ${msg}`);
}

if (!fs.existsSync(SERVER_FILE)) {
  log("server.js not found — camofox-browser may not be installed yet. Skipping.");
  process.exit(0);
}

let source = fs.readFileSync(SERVER_FILE, "utf8");

// Check if already patched
if (source.includes("window.scrollBy(d, 0)") || source.includes("window.scrollBy(0, d)")) {
  log("already patched — nothing to do.");
  process.exit(0);
}

// Patch 1: /tabs/:tabId/scroll endpoint (around line 2201)
const OLD_SCROLL_ENDPOINT = `    const isVertical = direction === 'up' || direction === 'down';
    const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
    await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);
    await tabState.page.waitForTimeout(300);`;

const NEW_SCROLL_ENDPOINT = `    const isVertical = direction === 'up' || direction === 'down';
    const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
    if (isVertical) {
      await tabState.page.evaluate((d) => window.scrollBy(0, d), delta);
    } else {
      await tabState.page.evaluate((d) => window.scrollBy(d, 0), delta);
    }
    await tabState.page.waitForTimeout(300);`;

// Patch 2: generic action route scroll (around line 3011)
const OLD_ACTION_SCROLL = `          } else {
            const isVertical = direction === 'up' || direction === 'down';
            const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
            await tabState.page.mouse.wheel(isVertical ? 0 : delta, isVertical ? delta : 0);
          }`;

const NEW_ACTION_SCROLL = `          } else {
            const isVertical = direction === 'up' || direction === 'down';
            const delta = (direction === 'up' || direction === 'left') ? -amount : amount;
            if (isVertical) {
              await tabState.page.evaluate((d) => window.scrollBy(0, d), delta);
            } else {
              await tabState.page.evaluate((d) => window.scrollBy(d, 0), delta);
            }
          }`;

let patched = 0;

if (source.includes(OLD_SCROLL_ENDPOINT)) {
  source = source.replace(OLD_SCROLL_ENDPOINT, NEW_SCROLL_ENDPOINT);
  patched++;
  log("patched /tabs/:tabId/scroll endpoint.");
} else {
  log("WARNING: could not find scroll endpoint code block.");
}

if (source.includes(OLD_ACTION_SCROLL)) {
  source = source.replace(OLD_ACTION_SCROLL, NEW_ACTION_SCROLL);
  patched++;
  log("patched generic action route scroll.");
} else {
  log("WARNING: could not find action route scroll code block.");
}

if (patched === 0) {
  log("ERROR: no patches applied. The plugin may have changed in a newer version.");
  process.exit(1);
}

fs.writeFileSync(SERVER_FILE, source, "utf8");
log(`patched ${patched} scroll location(s) successfully.`);
