#!/usr/bin/env node
/**
 * Patch the installed @askjo/camofox-browser plugin to add fullPage support
 * to the camofox_screenshot tool. This is idempotent — safe to run multiple times.
 */

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_DIR = path.join(
  process.env.HOME || "/Users/leonl",
  ".openclaw",
  "extensions",
  "camofox-browser"
);
const PLUGIN_FILE = path.join(PLUGIN_DIR, "plugin.ts");

function log(msg) {
  console.log(`[patch-camofox] ${msg}`);
}

if (!fs.existsSync(PLUGIN_FILE)) {
  log("plugin.ts not found — camofox-browser may not be installed yet. Skipping.");
  process.exit(0);
}

let source = fs.readFileSync(PLUGIN_FILE, "utf8");

// Check if already patched
if (source.includes("fullPage: { type: \"boolean\"")) {
  log("already patched — nothing to do.");
  process.exit(0);
}

// The original code block we want to replace
const OLD_BLOCK = `  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId } = params as { tabId: string };
      const userId = ctx.agentId || fallbackUserId;
      const url = \`\${baseUrl}/tabs/\${tabId}/screenshot?userId=\${userId}\`;`;

const NEW_BLOCK = `  api.registerTool((ctx: ToolContext) => ({
    name: "camofox_screenshot",
    description: "Take a screenshot of a Camoufox page. Use fullPage=true to capture the entire scrollable page, not just the visible viewport.",
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string", description: "Tab identifier" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page instead of just the viewport (default: false)" },
      },
      required: ["tabId"],
    },
    async execute(_id, params) {
      const { tabId, fullPage } = params as { tabId: string; fullPage?: boolean };
      const userId = ctx.agentId || fallbackUserId;
      const url = \`\${baseUrl}/tabs/\${tabId}/screenshot?userId=\${userId}\${fullPage ? '&fullPage=true' : ''}\`;`;

if (!source.includes(OLD_BLOCK)) {
  log("WARNING: could not find the expected original code block.");
  log("The plugin may have changed in a newer version. Manual intervention needed.");
  process.exit(1);
}

source = source.replace(OLD_BLOCK, NEW_BLOCK);
fs.writeFileSync(PLUGIN_FILE, source, "utf8");
log("patched camofox_screenshot tool with fullPage support.");
