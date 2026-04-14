#!/usr/bin/env node
// Message relay — collects new emails and SMS, sends summaries to OpenClaw.
// Also maintains SMS conversation history in /home/clawuser/workspace/sms/
// with one file per phone number.
//
// Email: polls himalaya (IMAP) and gog (Gmail) every 2 minutes
// SMS: triggers inbox export → receives webhooks on port 18790 → batches
//
// Env vars: SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execSync, execFileSync } = require("node:child_process");

const SMS_URL = process.env.SMS_GATEWAY_URL;
const SMS_USER = process.env.SMS_GATEWAY_USERNAME;
const SMS_PASS = process.env.SMS_GATEWAY_PASSWORD;
const WEBHOOK_PORT = Number.parseInt(process.env.RELAY_PORT || "18790", 10);
const POLL_INTERVAL = Number.parseInt(process.env.RELAY_POLL_INTERVAL || "120000", 10);
const SMS_HISTORY_DIR = "/home/clawuser/workspace/sms";

const seenEmails = new Set();
const seenSms = new Set();
const pendingSms = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
}

function smsApi(method, apiPath, body) {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return "";
  const bodyArg = body ? `-d '${JSON.stringify(body)}'` : "";
  const ct = body ? '-H "Content-Type: application/json"' : "";
  const nl = String.raw`\n`;
  const cmd = `curl -s -w "${nl}HTTP_%{http_code}" -X ${method} -u "${SMS_USER}:${SMS_PASS}" ${ct} ${bodyArg} "${SMS_URL}${apiPath}"`;
  const raw = run(cmd);
  const lines = raw.split("\n");
  const statusLine = lines.pop();
  const responseBody = lines.join("\n");
  if (statusLine && !statusLine.includes("HTTP_2")) {
    console.error(`[relay] SMS API ${method} ${apiPath} → ${statusLine}: ${responseBody.slice(0, 200)}`);
  }
  return responseBody;
}

function sendToAgent(text) {
  if (!text.trim()) return;
  try {
    const result = execFileSync("openclaw",
      ["agent", "--channel", "last", "--deliver", "--message", text.trim()],
      { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
    if (result.includes("Error") || result.includes("error")) {
      console.error("[relay] Send failed:", result.slice(0, 200));
    }
  } catch (e) {
    console.error("[relay] Send failed:", (e.stderr || e.message || "").slice(0, 200));
  }
}

// ── SMS history ──────────────────────────────────────────────────────────────
// One text file per phone number at /home/clawuser/workspace/sms/<number>.txt
// Format: [YYYY-MM-DD HH:MM] <direction> message text

function sanitizeNumber(num) {
  return num.replaceAll(/[^+0-9]/g, "") || "unknown";
}

function appendSmsHistory(number, direction, text, timestamp) {
  fs.mkdirSync(SMS_HISTORY_DIR, { recursive: true });
  const file = path.join(SMS_HISTORY_DIR, `${sanitizeNumber(number)}.txt`);
  const time = (timestamp || new Date().toISOString()).slice(0, 16).replace("T", " ");
  const prefix = direction === "in" ? "THEM" : "ME";
  const line = `[${time}] ${prefix}: ${text}\n`;

  // Avoid duplicate lines (check last 5 lines)
  try {
    const existing = fs.readFileSync(file, "utf8");
    const lastLines = existing.trim().split("\n").slice(-5);
    if (lastLines.some(l => l.includes(text.slice(0, 40)))) return;
  } catch { /* file doesn't exist yet */ }

  fs.appendFileSync(file, line, "utf8");
}

// Also track outbound messages sent via the SMS Gateway API
function pollSentMessages() {
  const raw = smsApi("GET", "/3rdparty/v1/message?limit=20");
  if (!raw) return;
  try {
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages)) return;
    for (const msg of messages) {
      const key = `sent:${msg.id}`;
      if (seenSms.has(key)) continue;
      seenSms.add(key);
      const text = msg.message || "";
      const time = msg.createdAt || new Date().toISOString();
      for (const r of (msg.recipients || [])) {
        appendSmsHistory(r.phoneNumber, "out", text, time);
      }
    }
  } catch { /* ignore */ }
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
        appendSmsHistory(sender, "in", text, time);
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

function cleanupStaleWebhooks(currentUrl) {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;
  const listRaw = smsApi("GET", "/3rdparty/v1/webhooks");
  if (!listRaw) return;
  let hooks;
  try { hooks = JSON.parse(listRaw); } catch { return; }
  if (!Array.isArray(hooks)) return;
  const stale = hooks.filter(h => !currentUrl || h.url !== currentUrl);
  if (stale.length === 0) return;
  for (const h of stale) {
    const delStatus = smsApi("DELETE", `/3rdparty/v1/webhooks/${h.id}`);
    console.log(`[relay] Deleted stale webhook ${h.id} (${h.url}) → ${delStatus || "ok"}`);
  }
  console.log(`[relay] Cleaned up ${stale.length} stale webhook(s)`);
}

function ensureSmsWebhook() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;
  const base = getTunnelUrl();
  if (!base) return;
  const webhookUrl = base + "/sms";
  if (webhookUrl === lastRegisteredUrl) return;
  cleanupStaleWebhooks(webhookUrl);
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
  if (!devicesRaw) return;
  let devices;
  try { devices = JSON.parse(devicesRaw); } catch { return; }
  const deviceId = Array.isArray(devices) ? devices[0]?.id : devices?.id;
  if (!deviceId) { console.log("[relay] No SMS device found"); return; }
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
    lines.push(`  (full history: /home/clawuser/workspace/sms/${sanitizeNumber(sender)}.txt)`);
  }
  pendingSms.length = 0;
  return lines.join("\n");
}

// ── Email polling ────────────────────────────────────────────────────────────

function pollHimalaya() {
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
  pollSentMessages(); // track outbound SMS for history

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

  for (const s of [seenEmails, seenSms]) {
    if (s.size > 5000) {
      const arr = [...s];
      s.clear();
      for (const item of arr.slice(-2500)) s.add(item);
    }
  }
}

// ── Start ────────────────────────────────────────────────────────────────────

fs.mkdirSync(SMS_HISTORY_DIR, { recursive: true });

server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
  console.log(`[relay] Webhook listener on port ${WEBHOOK_PORT}, polling every ${POLL_INTERVAL / 1000}s`);
  console.log(`[relay] SMS: ${SMS_URL ? "enabled" : "disabled (no SMS_GATEWAY_URL)"}`);
  console.log(`[relay] SMS history: ${SMS_HISTORY_DIR}`);
  console.log(`[relay] Tunnel: ${getTunnelUrl() || "waiting..."}`);
});

setTimeout(poll, 15000);
setInterval(poll, POLL_INTERVAL);
