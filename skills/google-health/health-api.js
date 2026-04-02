#!/usr/bin/env node
// Google Health API wrapper. Refreshes OAuth token directly from credentials.json
// + gog-token.json (the refresh token). No dependency on `gog auth token`.
//
// Usage:
//   node health-api.js list <dataType> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//   node health-api.js daily <dataType> --since YYYY-MM-DD --until YYYY-MM-DD
//   node health-api.js create <dataType> <jsonBody>
//   node health-api.js profile
//   node health-api.js settings

const fs = require("node:fs");

const BASE = "https://health.googleapis.com/v4";
const CREDS_DIR = "/home/clawuser/credentials";

let cachedToken = null;
let tokenExpiry = 0;

function loadJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60000) return cachedToken;

  const credsFile = loadJson(`${CREDS_DIR}/credentials.json`);
  const creds = credsFile?.installed || credsFile?.web;

  // Try gog token first, then dedicated health token
  const gogToken = loadJson(`${CREDS_DIR}/gog-token.json`);
  const healthToken = loadJson(`${CREDS_DIR}/google-health-token.json`);
  const refreshToken = gogToken?.refresh_token || healthToken?.refresh_token;

  if (!creds || !refreshToken) {
    console.error("ERROR: Missing credentials.json or refresh token in /home/clawuser/credentials/");
    console.error("Google Health API is not configured. Ask the owner to set up OAuth credentials.");
    process.exit(1);
  }

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await resp.json();
  if (!resp.ok || !data.access_token) {
    console.error("ERROR: Token refresh failed:", data.error_description || data.error);
    process.exit(1);
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

async function api(method, apiPath, body) {
  const token = await getToken();
  const opts = {
    method,
    headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
  };
  if (body) opts.body = typeof body === "string" ? body : JSON.stringify(body);

  const resp = await fetch(`${BASE}${apiPath}`, opts);
  const text = await resp.text();

  if (!resp.ok) { console.error(`ERROR ${resp.status}: ${text.slice(0, 500)}`); process.exit(1); }

  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
  catch { console.log(text); }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = {};
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) flags.since = args[++i];
    else if (args[i] === "--until" && args[i + 1]) flags.until = args[++i];
    else positional.push(args[i]);
  }
  return { cmd, positional, flags };
}

async function main() {
  const { cmd, positional, flags } = parseArgs();

  if (!cmd) {
    console.log(`Usage:
  node health-api.js list <type> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  node health-api.js daily <type> --since YYYY-MM-DD --until YYYY-MM-DD
  node health-api.js create <type> '<json>'
  node health-api.js profile|settings

Types: steps sleep exercise weight bodyFat nutritionLog hydrationLog
       dailyRestingHeartRate dailyHeartRateVariability activeMinutes totalCalories distance`);
    return;
  }

  if (cmd === "profile") return api("GET", "/users/me/profile");
  if (cmd === "settings") return api("GET", "/users/me/settings");

  const dt = positional[0];
  if (!dt) { console.error("ERROR: data type required"); process.exit(1); }

  if (cmd === "list") {
    const f = [];
    if (flags.since) f.push(`startTime>=${flags.since}`);
    if (flags.until) f.push(`startTime<${flags.until}`);
    const qs = f.length ? `?filter=${encodeURIComponent(f.join(" AND "))}` : "";
    return api("GET", `/users/me/dataTypes/${dt}/dataPoints${qs}`);
  }

  if (cmd === "daily") {
    if (!flags.since || !flags.until) { console.error("ERROR: --since and --until required"); process.exit(1); }
    const [sy, sm, sd] = flags.since.split("-").map(Number);
    const [ey, em, ed] = flags.until.split("-").map(Number);
    return api("POST", `/users/me/dataTypes/${dt}/dataPoints:dailyRollUp`, {
      startDate: { year: sy, month: sm, day: sd },
      endDate: { year: ey, month: em, day: ed },
    });
  }

  if (cmd === "create") {
    const raw = positional[1];
    if (!raw) { console.error("ERROR: JSON body required"); process.exit(1); }
    let data;
    try { data = JSON.parse(raw); } catch { console.error("ERROR: invalid JSON"); process.exit(1); }
    const now = new Date().toISOString();
    const payload = { data, startTime: data.startTime || now, endTime: data.endTime || now };
    delete payload.data.startTime;
    delete payload.data.endTime;
    return api("POST", `/users/me/dataTypes/${dt}/dataPoints`, payload);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch(err => { console.error("ERROR:", err.message); process.exit(1); });
