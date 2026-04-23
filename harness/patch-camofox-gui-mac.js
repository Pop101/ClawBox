#!/usr/bin/env node
/**
 * Patch the installed @askjo/camofox-browser plugin for native macOS GUI mode.
 *
 * On native macOS (darwin without FLY_MACHINE_ID), we want the browser window
 * to be visible. This requires:
 *  1. lib/config.js    — read CAMOFOX_HEADLESS env var
 *  2. plugin.ts        — expose headless in PluginConfig, pass to env
 *  3. server.js        — default headless:false on native macOS
 *  4. playwright firefox.js — don't pass -silent in non-headless mode
 *
 * This script is a NO-OP on non-macOS platforms or inside Docker/Fly.
 */

const fs = require("node:fs");
const path = require("node:path");

const isDarwin = process.platform === 'darwin';
const isFly = !!process.env.FLY_MACHINE_ID;
const isNativeMac = isDarwin && !isFly;

function log(msg) {
  console.log(`[patch-camofox-gui] ${msg}`);
}

if (!isNativeMac) {
  log(`skipping — platform=${process.platform}, fly=${isFly}. GUI patches only apply to native macOS.`);
  process.exit(0);
}

const PLUGIN_DIR = path.join(
  process.env.HOME || "/Users/leonl",
  ".openclaw",
  "extensions",
  "camofox-browser"
);

if (!fs.existsSync(PLUGIN_DIR)) {
  log("plugin dir not found — camofox-browser may not be installed yet.");
  process.exit(0);
}

let patched = 0;

// ── Patch 1: lib/config.js ──
const CONFIG_FILE = path.join(PLUGIN_DIR, "lib", "config.js");
if (fs.existsSync(CONFIG_FILE)) {
  let src = fs.readFileSync(CONFIG_FILE, "utf8");
  if (!src.includes("headless:")) {
    // Add headless option after the port line
    src = src.replace(
      "port: parseInt(process.env.CAMOFOX_PORT || process.env.PORT || '9377', 10),",
      "port: parseInt(process.env.CAMOFOX_PORT || process.env.PORT || '9377', 10),\n    headless: process.env.CAMOFOX_HEADLESS !== undefined ? process.env.CAMOFOX_HEADLESS === 'true' : undefined,"
    );
    fs.writeFileSync(CONFIG_FILE, src, "utf8");
    log("patched lib/config.js with headless option.");
    patched++;
  } else {
    log("lib/config.js already patched — skipping.");
  }
}

// ── Patch 2: plugin.ts ──
const PLUGIN_TS = path.join(PLUGIN_DIR, "plugin.ts");
if (fs.existsSync(PLUGIN_TS)) {
  let src = fs.readFileSync(PLUGIN_TS, "utf8");
  let changed = false;

  // Add headless to PluginConfig interface
  if (!src.includes("headless?:")) {
    src = src.replace(
      "interface PluginConfig {\n  url?: string;\n  autoStart?: boolean;\n  port?: number;",
      "interface PluginConfig {\n  url?: string;\n  autoStart?: boolean;\n  port?: number;\n  headless?: boolean;"
    );
    changed = true;
  }

  // Pass headless to env in startServer
  if (!src.includes("CAMOFOX_HEADLESS")) {
    src = src.replace(
      "if (pluginCfg?.browserIdleTimeoutMs != null) env.BROWSER_IDLE_TIMEOUT_MS = String(pluginCfg.browserIdleTimeoutMs);",
      "if (pluginCfg?.browserIdleTimeoutMs != null) env.BROWSER_IDLE_TIMEOUT_MS = String(pluginCfg.browserIdleTimeoutMs);\n  if (pluginCfg?.headless !== undefined) env.CAMOFOX_HEADLESS = String(pluginCfg.headless);"
    );
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(PLUGIN_TS, src, "utf8");
    log("patched plugin.ts with headless support.");
    patched++;
  } else {
    log("plugin.ts already patched — skipping.");
  }
}

// ── Patch 3: server.js — default headless:false on native macOS ──
const SERVER_FILE = path.join(PLUGIN_DIR, "server.js");
if (fs.existsSync(SERVER_FILE)) {
  let src = fs.readFileSync(SERVER_FILE, "utf8");
  if (!src.includes("isDarwinNative")) {
    // Replace the hardcoded headless line in launchOptions call
    src = src.replace(
      "const useVirtualDisplay = !!vdDisplay;\n    log('info', 'launching camoufox', {",
      "const useVirtualDisplay = !!vdDisplay;\n    // Native macOS: default to GUI mode unless explicitly configured otherwise\n    const isDarwinNative = os.platform() === 'darwin' && !process.env.FLY_MACHINE_ID;\n    const headlessMode = CONFIG.headless !== undefined ? CONFIG.headless : (isDarwinNative ? false : true);\n    log('info', 'launching camoufox', {"
    );
    // Replace the hardcoded headless option in launchOptions
    src = src.replace(
      "headless: useVirtualDisplay ? false : true,",
      "headless: useVirtualDisplay ? false : headlessMode,"
    );
    // Add headless to the launch log
    src = src.replace(
      "proxyPoolSize: proxyPool?.size || 0,\n      virtualDisplay: useVirtualDisplay,",
      "proxyPoolSize: proxyPool?.size || 0,\n      virtualDisplay: useVirtualDisplay,\n      headless: headlessMode,"
    );
    fs.writeFileSync(SERVER_FILE, src, "utf8");
    log("patched server.js with native macOS GUI default.");
    patched++;
  } else {
    log("server.js already patched — skipping.");
  }
}

// ── Patch 4: playwright-core firefox launcher ──
const PLAYWRIGHT_FILE = path.join(
  PLUGIN_DIR,
  "node_modules",
  "playwright-core",
  "lib",
  "server",
  "firefox",
  "firefox.js"
);
if (fs.existsSync(PLAYWRIGHT_FILE)) {
  let src = fs.readFileSync(PLAYWRIGHT_FILE, "utf8");
  if (!src.includes("!headless && !isPersistent")) {
    src = src.replace(
      "    if (isPersistent)\n      firefoxArguments.push(\"about:blank\");\n    else\n      firefoxArguments.push(\"-silent\");",
      "    if (isPersistent || (!headless && !isPersistent))\n      firefoxArguments.push(\"about:blank\");\n    else\n      firefoxArguments.push(\"-silent\");"
    );
    fs.writeFileSync(PLAYWRIGHT_FILE, src, "utf8");
    log("patched playwright-core firefox launcher (no -silent in GUI mode).");
    patched++;
  } else {
    log("playwright-core already patched — skipping.");
  }
}

if (patched === 0) {
  log("nothing to patch — all patches already applied.");
} else {
  log(`applied ${patched} patch(es) for native macOS GUI mode.`);
}
