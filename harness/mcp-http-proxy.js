#!/usr/bin/env node
// Stdio-to-Streamable-HTTP MCP proxy.
// Implements the MCP Streamable HTTP transport spec (2025-03-26) over stdio.
//
// Usage: node mcp-http-proxy.js <url> [auth-header-value] [oauth-token-file]

const fs = require("node:fs");

const url = process.argv[2];
let auth = process.argv[3] || "";
const oauthFile = process.argv[4] || "";

if (!url) {
  process.stderr.write("Usage: node mcp-http-proxy.js <url> [auth] [oauth-token-file]\n");
  process.exit(1);
}

let sessionId = null;
let oauthTokens = null;

// ── OAuth token management ───────────────────────────────────────────────────

function loadOAuthTokens() {
  if (!oauthFile || !fs.existsSync(oauthFile)) return;
  try {
    oauthTokens = JSON.parse(fs.readFileSync(oauthFile, "utf8"));
    auth = `Bearer ${oauthTokens.access_token}`;
  } catch (e) {
    process.stderr.write(`[mcp-proxy] Failed to load OAuth tokens from ${oauthFile}: ${e.message}\n`);
  }
}

async function refreshIfNeeded() {
  if (!oauthTokens) return;
  if (Date.now() < (oauthTokens.expires_at || 0) - 300000) return;

  process.stderr.write("[mcp-proxy] Refreshing OAuth token...\n");
  try {
    // Use token_endpoint from the oauth file, or fall back to Notion's
    const tokenEndpoint = oauthTokens.token_endpoint || "https://mcp.notion.com/token";
    const resp = await fetch(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: oauthTokens.refresh_token,
        client_id: oauthTokens.client_id,
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    oauthTokens.access_token = data.access_token;
    oauthTokens.refresh_token = data.refresh_token;
    oauthTokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    auth = `Bearer ${oauthTokens.access_token}`;
    fs.writeFileSync(oauthFile, JSON.stringify(oauthTokens, null, 2) + "\n", "utf8");
    process.stderr.write("[mcp-proxy] Token refreshed\n");
  } catch (err) {
    process.stderr.write(`[mcp-proxy] Refresh failed: ${err.message}\n`);
  }
}

loadOAuthTokens();

// ── HTTP transport ───────────────────────────────────────────────────────────

function buildHeaders() {
  const h = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (auth) h["Authorization"] = auth;
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

async function sendRequest(json) {
  await refreshIfNeeded();

  const resp = await fetch(url, {
    method: "POST",
    headers: buildHeaders(),
    body: json,
  });

  // Capture session ID from initialize response
  const newSessionId = resp.headers.get("mcp-session-id");
  if (newSessionId) sessionId = newSessionId;

  // Handle 401 — try refresh and retry once
  if (resp.status === 401 && oauthTokens) {
    oauthTokens.expires_at = 0;
    await refreshIfNeeded();
    const retry = await fetch(url, { method: "POST", headers: buildHeaders(), body: json });
    const retrySessionId = retry.headers.get("mcp-session-id");
    if (retrySessionId) sessionId = retrySessionId;
    return handleResponse(retry, json);
  }

  // Handle 404 — session expired, clear and let OpenClaw reinitialize
  if (resp.status === 404) {
    sessionId = null;
  }

  return handleResponse(resp, json);
}

async function handleResponse(resp, json) {
  const ct = resp.headers.get("content-type") || "";

  if (ct.includes("text/event-stream")) {
    // SSE stream — extract data lines
    const text = await resp.text();
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") {
          process.stdout.write(data + "\n");
        }
      }
    }
  } else {
    // JSON response
    const text = await resp.text();
    if (text.trim()) process.stdout.write(text.trim() + "\n");
  }
}

// ── Stdio bridge ─────────────────────────────────────────────────────────────

let buffer = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  const lines = buffer.split("\n");
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) handleMessage(line.trim());
  }
});
process.stdin.on("end", () => {
  if (buffer.trim()) handleMessage(buffer.trim());
});

async function handleMessage(json) {
  try {
    await sendRequest(json);
  } catch (err) {
    let id = null;
    try { id = JSON.parse(json).id; } catch { /* ignore */ }
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id,
      error: { code: -32000, message: "MCP proxy: " + err.message },
    }) + "\n");
  }
}
