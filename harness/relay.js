#!/usr/bin/env node
// Message relay — collects new emails and SMS, sends summaries to OpenClaw.
//
// Email: polls himalaya (IMAP) and gog (Gmail) every 2 minutes
// SMS: triggers inbox export → receives webhooks on port 18790 → batches
//
// Env vars: SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD

const http = require("node:http");
const fs = require("node:fs");
const { execSync } = require("node:child_process");

const SMS_URL = process.env.SMS_GATEWAY_URL;
const SMS_USER = process.env.SMS_GATEWAY_USERNAME;
const SMS_PASS = process.env.SMS_GATEWAY_PASSWORD;
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
  const nl = String.raw`\n`;
  const cmd = `curl -s -w "${nl}HTTP_%{http_code}" -X ${method} -u "${SMS_USER}:${SMS_PASS}" ${ct} ${bodyArg} "${SMS_URL}${path}"`;
  const raw = run(cmd);
  const lines = raw.split("\n");
  const statusLine = lines.pop();
  const responseBody = lines.join("\n");
  if (statusLine && !statusLine.includes("HTTP_2")) {
    console.error(`[relay] SMS API ${method} ${path} → ${statusLine}: ${responseBody.slice(0, 200)}`);
  }
  return responseBody;
}

function sendToAgent(text) {
  if (!text.trim()) return;
  // Inject into the most recent conversation — wherever the user last chatted
  const escaped = text.trim().replaceAll("'", String.raw`'\''`);
  const result = run(`openclaw agent --channel last --deliver --message '${escaped}' 2>&1`);
  if (result.includes("Error") || result.includes("error")) {
    console.error("[relay] Send failed:", result.slice(0, 200));
  }
}

// ── SMS webhook receiver ─────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  console.log(`[relay] HTTP ${req.method} ${req.url}`);

  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

  let body = "";
  for await (const chunk of req) body += chunk;
  console.log(`[relay] Webhook body (${body.length} bytes): ${body.slice(0, 200)}`);

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

  const regResult = smsApi("POST", "/3rdparty/v1/webhooks", { url: webhookUrl, event: "sms:received" });
  lastRegisteredUrl = webhookUrl;
  console.log(`[relay] Registered SMS webhook: ${webhookUrl} → ${regResult || "(empty response)"}`);
}

function triggerSmsExport() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;
  if (!getTunnelUrl()) {
    console.log("[relay] No tunnel — skipping SMS export");
    return;
  }

  const devicesRaw = smsApi("GET", "/3rdparty/v1/device");
  console.log(`[relay] Devices response: ${devicesRaw || "(empty)"}`);
  if (!devicesRaw) return;

  let devices;
  try { devices = JSON.parse(devicesRaw); } catch { return; }
  const deviceId = Array.isArray(devices) ? devices[0]?.id : devices?.id;
  if (!deviceId) { console.log("[relay] No SMS device found in response"); return; }

  // Look back 10 minutes to catch anything missed
  const since = new Date(Date.now() - 600000).toISOString();
  const until = new Date().toISOString();

  const exportResult = smsApi("POST", "/3rdparty/v1/messages/inbox/export", { deviceId, since, until });
  console.log(`[relay] Export triggered for device ${deviceId} (${since.slice(11,19)} - ${until.slice(11,19)}) → ${exportResult || "(202 accepted)"}`);
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
  // List recent emails (not just unseen — catches read-but-new-since-last-poll)
  const output = run('himalaya envelope list --page-size 20 --output json 2>/dev/null');
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
  // List recent emails (not just unread)
  const output = run("gog gmail list --limit 20 --format json 2>/dev/null");
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
