#!/usr/bin/env node
// Message relay — collects new emails and SMS, sends summaries to OpenClaw.
//
// Email: polls himalaya (IMAP) and gog (Gmail) every 2 minutes
// SMS: triggers inbox export → receives webhooks on port 18790 → batches
//
// Env vars: SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD,
//           TELEGRAM_ALLOW_FROM (used as target for openclaw message send)

const http = require("node:http");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const SMS_URL = process.env.SMS_GATEWAY_URL;
const SMS_USER = process.env.SMS_GATEWAY_USERNAME;
const SMS_PASS = process.env.SMS_GATEWAY_PASSWORD;
const CHAT_ID = process.env.TELEGRAM_ALLOW_FROM || "";
const WEBHOOK_PORT = Number.parseInt(process.env.RELAY_PORT || "18790", 10);
const POLL_INTERVAL = Number.parseInt(process.env.RELAY_POLL_INTERVAL || "120000", 10);

const seenEmails = new Set();
const seenSms = new Set();
const pendingSms = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
}

function smsApi(method, path, body) {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return "";
  const bodyArg = body ? `-d '${JSON.stringify(body)}'` : "";
  const ct = body ? '-H "Content-Type: application/json"' : "";
  return run(`curl -sf -X ${method} -u "${SMS_USER}:${SMS_PASS}" ${ct} ${bodyArg} "${SMS_URL}${path}" 2>/dev/null`);
}

function sendToAgent(text) {
  if (!text.trim()) return;
  // Use openclaw CLI to send message — works with whatever channel is active
  const escaped = text.trim().replaceAll("'", String.raw`'\''`);
  const result = run(`openclaw message send --channel telegram --target "${CHAT_ID}" --message '${escaped}' 2>&1`);
  if (result.includes("Error") || result.includes("error")) {
    console.error("[relay] Send failed:", result.slice(0, 200));
  }
}

// ── SMS webhook receiver ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Accept any POST (SMS Gateway sends to the root or /sms)
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const data = JSON.parse(body);
    const messages = [];
    if (data.payload) messages.push(data.payload);
    else if (Array.isArray(data)) messages.push(...data);
    else if (data.message && (data.phoneNumber || data.sender)) messages.push(data);

    for (const msg of messages) {
      const sender = msg.sender || msg.phoneNumber || msg.from || "unknown";
      const text = msg.message || msg.body || msg.text || "";
      const time = msg.receivedAt || new Date().toISOString();
      const key = `${sender}:${text.slice(0, 40)}:${time.slice(0, 16)}`;

      if (!seenSms.has(key)) {
        seenSms.add(key);
        pendingSms.push({ sender, text, time });
        console.log(`[relay] SMS webhook received: ${sender} (${text.slice(0, 30)}...)`);
      }
    }

    res.writeHead(200);
    res.end("ok");
  } catch (err) {
    console.error("[relay] Webhook parse error:", err.message);
    res.writeHead(400);
    res.end("error");
  }
});

// ── Tunnel URL + SMS webhook management ──────────────────────────────────────

let lastRegisteredUrl = "";

function getTunnelUrl() {
  const manual = process.env.TUNNEL_URL;
  if (manual) return manual;
  try { return fs.readFileSync("/tmp/tunnel-url", "utf8").trim(); }
  catch { return ""; }
}

function ensureSmsWebhook() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;

  const base = getTunnelUrl();
  if (!base) return;

  const webhookUrl = base + "/sms";
  if (webhookUrl === lastRegisteredUrl) return;

  smsApi("POST", "/api/3rdparty/v1/webhooks", { url: webhookUrl, event: "sms:received" });
  lastRegisteredUrl = webhookUrl;
  console.log(`[relay] Registered SMS webhook: ${webhookUrl}`);
}

function triggerSmsExport() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;
  if (!getTunnelUrl()) {
    console.log("[relay] No tunnel — skipping SMS export");
    return;
  }

  const devicesRaw = smsApi("GET", "/api/3rdparty/v1/device");
  if (!devicesRaw) return;

  let devices;
  try { devices = JSON.parse(devicesRaw); } catch { return; }
  const deviceId = Array.isArray(devices) ? devices[0]?.id : devices?.id;
  if (!deviceId) { console.log("[relay] No SMS device found"); return; }

  const since = new Date(Date.now() - POLL_INTERVAL - 30000).toISOString();
  const until = new Date().toISOString();

  smsApi("POST", "/api/3rdparty/v1/messages/inbox/export", { deviceId, since, until });
  console.log(`[relay] Triggered SMS inbox export for device ${deviceId}`);
}

// ── SMS summary builder ──────────────────────────────────────────────────────

function buildSmsSection() {
  if (pendingSms.length === 0) return "";

  const bySender = {};
  for (const msg of pendingSms) {
    if (!bySender[msg.sender]) bySender[msg.sender] = [];
    bySender[msg.sender].push(msg);
  }

  const lines = [];
  for (const [sender, msgs] of Object.entries(bySender)) {
    lines.push(`SMS from ${sender}:`);
    for (const m of msgs) {
      const time = m.time.slice(11, 16);
      lines.push(`  [${time}] ${m.text.slice(0, 300)}`);
    }
  }

  pendingSms.length = 0;
  return lines.join("\n");
}

// ── Email polling ────────────────────────────────────────────────────────────

function pollHimalaya() {
  const output = run('himalaya envelope list --query "unseen" --output json 2>/dev/null');
  if (!output) return [];

  const results = [];
  try {
    for (const e of JSON.parse(output)) {
      const key = `h:${e.id}`;
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);

      let preview = "";
      const full = run(`himalaya message read ${e.id} 2>/dev/null`);
      if (full) preview = full.split("\n").slice(0, 3).join(" ").slice(0, 200);

      results.push({ source: "himalaya", from: e.from || "unknown", subject: e.subject || "(no subject)", preview });
    }
  } catch { /* ignore */ }
  return results;
}

function pollGog() {
  const output = run("gog gmail list --unread --format json 2>/dev/null");
  if (!output) return [];

  const results = [];
  try {
    for (const msg of JSON.parse(output)) {
      const key = `g:${msg.id || msg.messageId}`;
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);

      results.push({
        source: "gmail",
        from: msg.from || msg.sender || "unknown",
        subject: msg.subject || "(no subject)",
        preview: (msg.snippet || "").slice(0, 200),
      });
    }
  } catch { /* ignore */ }
  return results;
}

function buildEmailSection(emails) {
  if (emails.length === 0) return "";
  const lines = [];
  for (const e of emails) {
    lines.push(`Email (${e.source}) from ${e.from}: ${e.subject}`);
    if (e.preview) lines.push(`  ${e.preview}...`);
  }
  return lines.join("\n");
}

// ── Main poll cycle ──────────────────────────────────────────────────────────

async function poll() {
  console.log("[relay] Polling...");

  ensureSmsWebhook();
  triggerSmsExport();

  // Wait for webhooks to arrive from the phone
  await new Promise(r => setTimeout(r, 5000));

  const smsSection = buildSmsSection();
  const allEmails = [...pollHimalaya(), ...pollGog()];
  const emailSection = buildEmailSection(allEmails);

  if (!smsSection && !emailSection) {
    console.log("[relay] No new messages");
    return;
  }

  let summary = "New messages:\n\n";
  if (smsSection) summary += smsSection + "\n\n";
  if (emailSection) summary += emailSection;

  sendToAgent(summary);
  console.log("[relay] Summary sent to agent");

  // Trim seen sets
  for (const s of [seenEmails, seenSms]) {
    if (s.size > 5000) {
      const arr = [...s];
      s.clear();
      for (const item of arr.slice(-2500)) s.add(item);
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
  console.log(`[relay] Webhook listener on port ${WEBHOOK_PORT}, polling every ${POLL_INTERVAL / 1000}s`);
  console.log(`[relay] SMS: ${SMS_URL ? "enabled" : "disabled (no SMS_GATEWAY_URL)"}`);
  console.log(`[relay] Tunnel: ${getTunnelUrl() || "waiting..."}`);
});

setTimeout(poll, 15000);
setInterval(poll, POLL_INTERVAL);
