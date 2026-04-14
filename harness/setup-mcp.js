#!/usr/bin/env node
// Reads mcpServers from models.json and registers them via `openclaw mcp set`.
// This runs during container boot before the gateway starts. The CLI writes to
// mcp.servers in openclaw.json through the proper config path that survives
// gateway rewrites, so no live gateway restart is needed.
//
// For remote HTTP endpoints, wraps them in mcp-http-proxy.js (stdio bridge).
// Supports {{VAR}} template resolution from provider apiKeys and process.env.

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const SCRIPT_DIR = __dirname;
const modelsJsonPath = path.join(SCRIPT_DIR, "..", "models.json");
const proxyScript = path.join(SCRIPT_DIR, "mcp-http-proxy.js");

if (!fs.existsSync(modelsJsonPath)) {
  console.log("[setup-mcp] No models.json found, skipping");
  process.exit(0);
}

const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
if (!modelsJson.mcpServers || Object.keys(modelsJson.mcpServers).length === 0) {
  console.log("[setup-mcp] No MCP servers configured");
  process.exit(0);
}

function env(name) {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  if (!trimmed || /^your-|^change-me|^placeholder/i.test(trimmed)) return undefined;
  return trimmed;
}

function resolveTemplate(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, varName) => {
    const fromEnv = env(varName);
    if (fromEnv) return fromEnv;
    for (const p of Object.values(modelsJson.providers || {})) {
      if (p.apiKey && !p.apiKey.includes("{{") && varName.toLowerCase().includes(p.provider)) return p.apiKey;
    }
    return "";
  });
}

function resolveObj(obj) {
  if (typeof obj === "string") return resolveTemplate(obj);
  if (Array.isArray(obj)) return obj.map(resolveObj);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveObj(v)]));
  }
  return obj;
}

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 120000, stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch (e) {
    return e.stderr?.trim() || e.message;
  }
}

for (const [name, cfg] of Object.entries(modelsJson.mcpServers)) {
  let serverConfig;

  if (cfg.command) {
    // Native stdio server
    serverConfig = {
      command: cfg.command,
      args: resolveObj(cfg.args || []),
      ...(cfg.env ? { env: resolveObj(cfg.env) } : {}),
    };
  } else if (cfg.url) {
    // Remote HTTP — proxy via mcp-http-proxy.js
    const resolvedUrl = resolveTemplate(cfg.url);
    const resolvedAuth = cfg.auth ? resolveTemplate(cfg.auth) : "";
    const args = [proxyScript, resolvedUrl, resolvedAuth];
    if (cfg.oauthFile) args.push(cfg.oauthFile);
    serverConfig = { command: "node", args };
  }

  if (!serverConfig) continue;

  const result = run("openclaw", ["mcp", "set", name, JSON.stringify(serverConfig)]);
  console.log(`[setup-mcp] ${name}: ${result || "ok"}`);
}

console.log("[setup-mcp] Done.");
