#!/usr/bin/env node
// Google Health API OAuth setup. Run on your HOST machine.
// Uses your existing credentials.json from the credentials/ folder.
//
// Usage: node scripts/google-health-auth.js
//
// Prerequisites:
//   1. Enable the Google Health API at:
//      https://console.cloud.google.com/apis/api/health.googleapis.com
//   2. credentials/credentials.json must exist (your Google OAuth client)

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const PORT = 9877;
const CREDS_PATH = path.join(__dirname, "..", "credentials", "credentials.json");
const TOKEN_PATH = path.join(__dirname, "..", "credentials", "google-health-token.json");

if (!fs.existsSync(CREDS_PATH)) {
  console.error("ERROR: credentials/credentials.json not found.");
  console.error("Set up Google OAuth first — see README.md");
  process.exit(1);
}

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
const client = creds.installed || creds.web;
const clientId = client.client_id;
const clientSecret = client.client_secret;
const redirectUri = `http://localhost:${PORT}/callback`;

const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements",
  "https://www.googleapis.com/auth/googlehealth.nutrition",
  "https://www.googleapis.com/auth/googlehealth.sleep",
];

const state = crypto.randomBytes(16).toString("hex");
const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&access_type=offline&prompt=consent&scope=${encodeURIComponent(SCOPES.join(" "))}&state=${state}`;

console.log("Opening browser for Google Health API authorization...");
console.log(`\nIf it doesn't open, go to:\n${authUrl}\n`);

try {
  const cmd = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
  execSync(`${cmd} "${authUrl}"`, { stdio: "ignore" });
} catch { /* user has the URL */ }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (!url.pathname.startsWith("/callback")) { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  const returnedState = url.searchParams.get("state");

  if (error || !code) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end(`<h1>Failed</h1><p>${error || "No code"}</p>`);
    server.close();
    process.exit(1);
  }

  if (returnedState !== state) {
    res.writeHead(400, { "Content-Type": "text/html" });
    res.end("<h1>State mismatch</h1>");
    server.close();
    process.exit(1);
  }

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenResp.json();
    if (!tokenResp.ok || !tokens.access_token) {
      throw new Error(tokens.error_description || tokens.error || "Token exchange failed");
    }

    const saved = {
      client_id: clientId,
      client_secret: clientSecret,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: Date.now() + (tokens.expires_in || 3600) * 1000,
      scopes: SCOPES,
      saved_at: new Date().toISOString(),
    };

    fs.writeFileSync(TOKEN_PATH, JSON.stringify(saved, null, 2) + "\n", "utf8");

    console.log("\nSuccess! Token saved to credentials/google-health-token.json");
    console.log("Rebuild to apply: sh rebuild.sh");

    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h1>Google Health API connected!</h1><p>You can close this tab.</p>");
  } catch (err) {
    console.error("Token exchange failed:", err.message);
    res.writeHead(500, { "Content-Type": "text/html" });
    res.end(`<h1>Failed</h1><p>${err.message}</p>`);
  }

  server.close();
  setTimeout(() => process.exit(0), 500);
});

server.listen(PORT, () => {
  console.log(`Waiting for callback on http://localhost:${PORT}/callback ...`);
});
