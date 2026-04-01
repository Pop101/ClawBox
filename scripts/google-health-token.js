#!/usr/bin/env node
// Prints a fresh Google Health API access token to stdout.
// Auto-refreshes from credentials/google-health-token.json.
// Usage: node scripts/google-health-token.js
//        or: TOKEN=$(node /home/clawuser/openclaw/scripts/google-health-token.js)

const fs = require("node:fs");
const path = require("node:path");

const TOKEN_PATH = path.join(__dirname, "..", "credentials", "google-health-token.json");

if (!fs.existsSync(TOKEN_PATH)) {
  process.stderr.write("ERROR: credentials/google-health-token.json not found. Run: node scripts/google-health-auth.js\n");
  process.exit(1);
}

async function main() {
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));

  // Refresh if expired or expiring within 5 minutes
  if (Date.now() > (tokens.expires_at || 0) - 300000) {
    if (!tokens.refresh_token) {
      process.stderr.write("ERROR: No refresh token. Re-run: node scripts/google-health-auth.js\n");
      process.exit(1);
    }

    const resp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: tokens.client_id,
        client_secret: tokens.client_secret,
        refresh_token: tokens.refresh_token,
        grant_type: "refresh_token",
      }),
    });

    const data = await resp.json();
    if (!resp.ok || !data.access_token) {
      process.stderr.write("ERROR: Token refresh failed: " + (data.error_description || data.error) + "\n");
      process.exit(1);
    }

    tokens.access_token = data.access_token;
    tokens.expires_at = Date.now() + (data.expires_in || 3600) * 1000;
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2) + "\n", "utf8");
  }

  process.stdout.write(tokens.access_token);
}

main().catch(err => { process.stderr.write("ERROR: " + err.message + "\n"); process.exit(1); });
