#!/usr/bin/env node
// Notion OAuth setup — NO integration needed. Uses user-level "Sign in with Notion".
//
// 1. Dynamically registers a client with mcp.notion.com (no dashboard step)
// 2. Opens browser for user consent
// 3. Exchanges code for access + refresh tokens
// 4. Saves tokens to credentials/notion-oauth.json
//
// Usage: node scripts/notion-auth.js
//
// After this, the MCP proxy uses the saved tokens and auto-refreshes them.

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const PORT = 9876;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const TOKEN_PATH = path.join(__dirname, "..", "credentials", "notion-oauth.json");

async function main() {
  // Step 1: Dynamic client registration (no Notion dashboard needed)
  console.log("Registering OAuth client with Notion MCP...");
  const regResp = await fetch("https://mcp.notion.com/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "OpenClaw Personal Assistant",
      redirect_uris: [REDIRECT_URI],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });

  if (!regResp.ok) {
    const text = await regResp.text();
    console.error("Registration failed:", regResp.status, text);
    process.exit(1);
  }

  const client = await regResp.json();
  const clientId = client.client_id;
  console.log("Client registered:", clientId);

  // Step 2: PKCE
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("hex");

  // Step 3: Open browser
  const authUrl = `https://mcp.notion.com/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  console.log("\nOpening browser for Notion sign-in...");
  console.log("If it doesn't open, go to:\n" + authUrl + "\n");

  try {
    const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
    execSync(`${cmd} "${authUrl}"`, { stdio: "ignore" });
  } catch { /* user has the URL */ }

  // Step 4: Wait for callback
  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (!url.pathname.startsWith("/callback")) { res.writeHead(404); res.end(); return; }

      const returnedState = url.searchParams.get("state");
      const returnedCode = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error || !returnedCode) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end(`<h1>Failed</h1><p>${error || "No code"}</p>`);
        server.close();
        reject(new Error(error || "No code returned"));
        return;
      }

      if (returnedState !== state) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>State mismatch</h1>");
        server.close();
        reject(new Error("State mismatch"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h1>Notion connected!</h1><p>You can close this tab.</p>");
      server.close();
      resolve(returnedCode);
    });

    server.listen(PORT, () => {
      console.log(`Waiting for callback on http://localhost:${PORT}/callback ...`);
    });
  });

  // Step 5: Exchange code for tokens
  console.log("Exchanging code for tokens...");
  const tokenResp = await fetch("https://mcp.notion.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });

  if (!tokenResp.ok) {
    const text = await tokenResp.text();
    console.error("Token exchange failed:", tokenResp.status, text);
    process.exit(1);
  }

  const tokens = await tokenResp.json();

  // Step 6: Save
  const saved = {
    client_id: clientId,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
    saved_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(saved, null, 2) + "\n", "utf8");

  console.log("\nSuccess! Tokens saved to credentials/notion-oauth.json");
  console.log("The MCP proxy will auto-refresh tokens from here. Rebuild to apply.");
}

main().catch((err) => { console.error("Error:", err.message); process.exit(1); });
