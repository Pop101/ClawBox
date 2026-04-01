#!/usr/bin/env node
// Google Health API wrapper — uses gog's OAuth token for authentication.
// Provides a simple CLI for the agent to call without managing tokens directly.
//
// Usage:
//   node health-api.js list <dataType> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
//   node health-api.js daily <dataType> --since YYYY-MM-DD --until YYYY-MM-DD
//   node health-api.js create <dataType> <jsonBody>
//   node health-api.js profile
//   node health-api.js settings
//
// Examples:
//   node health-api.js list sleep --since 2026-03-25
//   node health-api.js list nutritionLog --since 2026-03-31
//   node health-api.js daily steps --since 2026-03-01 --until 2026-03-31
//   node health-api.js create nutritionLog '{"nutritionLogValue":{"foodName":"Chicken salad","mealType":"LUNCH","nutritionalValues":{"calories":450,"protein":35}}}'
//   node health-api.js profile

const { execSync } = require("node:child_process");

const BASE = "https://health.googleapis.com/v4";

function getToken() {
  try {
    return execSync("gog auth token 2>/dev/null", { encoding: "utf8" }).trim();
  } catch {
    console.error("ERROR: gog auth token failed. Run: bash scripts/gog-health-auth.sh you@email.com");
    process.exit(1);
  }
}

async function api(method, path, body) {
  const token = getToken();
  const opts = {
    method,
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = typeof body === "string" ? body : JSON.stringify(body);

  const resp = await fetch(`${BASE}${path}`, opts);
  const text = await resp.text();

  if (!resp.ok) {
    console.error(`ERROR ${resp.status}: ${text}`);
    process.exit(1);
  }

  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0];
  const flags = {};
  const positional = [];

  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--since" && args[i + 1]) { flags.since = args[++i]; }
    else if (args[i] === "--until" && args[i + 1]) { flags.until = args[++i]; }
    else { positional.push(args[i]); }
  }

  return { cmd, positional, flags };
}

async function main() {
  const { cmd, positional, flags } = parseArgs();

  if (!cmd) {
    console.log(`Usage:
  node health-api.js list <dataType> [--since YYYY-MM-DD] [--until YYYY-MM-DD]
  node health-api.js daily <dataType> --since YYYY-MM-DD --until YYYY-MM-DD
  node health-api.js create <dataType> <jsonBody>
  node health-api.js profile
  node health-api.js settings

Data types: steps, sleep, exercise, weight, bodyFat, nutritionLog, hydrationLog,
            dailyRestingHeartRate, dailyHeartRateVariability, activeMinutes,
            totalCalories, distance`);
    return;
  }

  if (cmd === "profile") return api("GET", "/users/me/profile");
  if (cmd === "settings") return api("GET", "/users/me/settings");

  const dataType = positional[0];
  if (!dataType && cmd !== "profile" && cmd !== "settings") {
    console.error("ERROR: data type required (e.g., steps, sleep, nutritionLog)");
    process.exit(1);
  }

  if (cmd === "list") {
    const filters = [];
    if (flags.since) filters.push(`startTime>=${flags.since}`);
    if (flags.until) filters.push(`startTime<${flags.until}`);
    const filter = filters.length ? `?filter=${encodeURIComponent(filters.join(" AND "))}` : "";
    return api("GET", `/users/me/dataTypes/${dataType}/dataPoints${filter}`);
  }

  if (cmd === "daily") {
    if (!flags.since || !flags.until) {
      console.error("ERROR: --since and --until required for daily rollup");
      process.exit(1);
    }
    const [sy, sm, sd] = flags.since.split("-").map(Number);
    const [ey, em, ed] = flags.until.split("-").map(Number);
    return api("POST", `/users/me/dataTypes/${dataType}/dataPoints:dailyRollUp`, {
      startDate: { year: sy, month: sm, day: sd },
      endDate: { year: ey, month: em, day: ed },
    });
  }

  if (cmd === "create") {
    const jsonBody = positional[1];
    if (!jsonBody) {
      console.error("ERROR: JSON body required for create");
      process.exit(1);
    }
    let data;
    try { data = JSON.parse(jsonBody); } catch { console.error("ERROR: invalid JSON"); process.exit(1); }

    const now = new Date().toISOString();
    const payload = { data, startTime: data.startTime || now, endTime: data.endTime || now };
    delete payload.data.startTime;
    delete payload.data.endTime;

    return api("POST", `/users/me/dataTypes/${dataType}/dataPoints`, payload);
  }

  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

main().catch(err => { console.error("ERROR:", err.message); process.exit(1); });
