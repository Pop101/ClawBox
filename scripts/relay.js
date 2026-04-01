#!/usr/bin/env node
// Message relay — polls email + triggers SMS inbox export every 2 minutes,
// collects incoming SMS via webhook, sends ONE batched summary to Telegram.
//
// SMS Gateway uses a pull-to-push model: we call POST /messages/inbox/export
// which triggers the phone to send sms:received webhooks to our listener.
//
// Env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOW_FROM,
//           SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD

const http = require("node:http");
const { execSync } = require("node:child_process");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_ALLOW_FROM;
const SMS_URL = process.env.SMS_GATEWAY_URL;
const SMS_USER = process.env.SMS_GATEWAY_USERNAME;
const SMS_PASS = process.env.SMS_GATEWAY_PASSWORD;
const POLL_INTERVAL = Number.parseInt(process.env.RELAY_POLL_INTERVAL || "120000", 10);
const WEBHOOK_PORT = Number.parseInt(process.env.RELAY_PORT || "18790", 10);

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("[relay] TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOW_FROM required");
  process.exit(1);
}

const seenEmails = new Set();
const seenSms = new Set();
const pendingSms = []; // collected from webhooks between poll cycles

// ── Helpers ──────────────────────────────────────────────────────────────────

async function sendTelegram(text) {
  try {
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) { chunks.push(remaining.slice(0, 4000)); remaining = remaining.slice(4000); }
    for (const chunk of chunks) {
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: chunk, parse_mode: "HTML", disable_web_page_preview: true }),
      });
    }
  } catch (err) { console.error("[relay] Telegram send failed:", err.message); }
}

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch { return ""; }
}

function smsApi(method, path, body) {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return "";
  const bodyArg = body ? `-d '${JSON.stringify(body)}'` : "";
  const contentType = body ? '-H "Content-Type: application/json"' : "";
  return run(`curl -sf -X ${method} -u "${SMS_USER}:${SMS_PASS}" ${contentType} ${bodyArg} "${SMS_URL}${path}" 2>/dev/null`);
}

function escHtml(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ── SMS webhook listener ─────────────────────────────────────────────────────
// Receives sms:received webhooks triggered by inbox export

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") { res.writeHead(404); res.end(); return; }

  let body = "";
  for await (const chunk of req) body += chunk;

  try {
    const data = JSON.parse(body);

    // Handle various webhook formats
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
        console.log(`[relay] SMS webhook: ${sender}`);
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

// ── SMS inbox export trigger ─────────────────────────────────────────────────

function triggerSmsExport() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;

  // Get device ID first
  const devicesRaw = smsApi("GET", "/api/3rdparty/v1/device");
  if (!devicesRaw) return;

  let devices;
  try { devices = JSON.parse(devicesRaw); } catch { return; }
  const deviceId = Array.isArray(devices) ? devices[0]?.id : devices?.id;
  if (!deviceId) return;

  // Export inbox for the last POLL_INTERVAL + 30s buffer
  const since = new Date(Date.now() - POLL_INTERVAL - 30000).toISOString();
  const until = new Date().toISOString();

  smsApi("POST", "/api/3rdparty/v1/messages/inbox/export", {
    deviceId,
    since,
    until,
  });

  console.log(`[relay] Triggered SMS inbox export (${since.slice(11, 19)} - ${until.slice(11, 19)})`);
}

// ── SMS summary builder ──────────────────────────────────────────────────────

function buildSmsSection() {
  if (pendingSms.length === 0) return "";

  // Group by sender
  const bySender = {};
  for (const msg of pendingSms) {
    if (!bySender[msg.sender]) bySender[msg.sender] = [];
    bySender[msg.sender].push(msg);
  }

  const sections = [];
  for (const [sender, msgs] of Object.entries(bySender)) {
    let section = `📱 <b>SMS from ${escHtml(sender)}</b>\n`;
    for (const m of msgs) {
      const time = m.time.slice(11, 16);
      section += `  [${time}] ${escHtml(m.text).slice(0, 300)}\n`;
    }
    sections.push(section);
  }

  // Clear pending
  pendingSms.length = 0;

  return sections.join("\n");
}

// ── Email polling ────────────────────────────────────────────────────────────

function pollHimalaya() {
  const output = run('himalaya envelope list --query "unseen" --output json 2>/dev/null');
  if (!output) return [];

  const newEmails = [];
  try {
    const envelopes = JSON.parse(output);
    for (const e of envelopes) {
      const key = `h:${e.id}`;
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);

      let body = "";
      const fullMsg = run(`himalaya message read ${e.id} 2>/dev/null`);
      if (fullMsg) body = fullMsg.slice(0, 500);

      newEmails.push({ source: "himalaya", from: e.from || "unknown", subject: e.subject || "(no subject)", body });
    }
  } catch { /* ignore */ }
  return newEmails;
}

function pollGog() {
  const output = run("gog gmail list --unread --format json 2>/dev/null");
  if (!output) return [];

  const newEmails = [];
  try {
    const messages = JSON.parse(output);
    for (const msg of messages) {
      const key = `g:${msg.id || msg.messageId}`;
      if (seenEmails.has(key)) continue;
      seenEmails.add(key);

      newEmails.push({
        source: "gmail",
        from: msg.from || msg.sender || "unknown",
        subject: msg.subject || "(no subject)",
        body: (msg.snippet || msg.body || "").slice(0, 500),
      });
    }
  } catch { /* ignore */ }
  return newEmails;
}

function buildEmailSection(emails) {
  if (emails.length === 0) return "";
  let section = "";
  for (const e of emails) {
    const tag = e.source === "gmail" ? "Gmail" : "himalaya";
    section += `📧 <b>Email (${tag})</b>\n`;
    section += `  From: ${escHtml(e.from)}\n`;
    section += `  Subject: ${escHtml(e.subject)}\n`;
    if (e.body) {
      section += `  ${escHtml(e.body.split("\n").slice(0, 3).join(" ")).slice(0, 200)}...\n`;
    }
    section += "\n";
  }
  return section;
}

// ── Main poll cycle ──────────────────────────────────────────────────────────

async function poll() {
  console.log("[relay] Polling...");

  // Re-check tunnel URL every poll — re-register webhook if URL changed
  ensureSmsWebhook();

  // Trigger SMS inbox export (webhooks arrive async into pendingSms)
  triggerSmsExport();

  // Wait 5s for webhooks to arrive from the phone
  await new Promise(r => setTimeout(r, 5000));

  const smsSection = buildSmsSection();
  const newHimalaya = pollHimalaya();
  const newGmail = pollGog();
  const allEmails = [...newHimalaya, ...newGmail];
  const emailSection = buildEmailSection(allEmails);

  if (!smsSection && !emailSection) {
    console.log("[relay] No new messages");
    return;
  }

  let summary = `<b>📬 New messages</b>\n\n`;
  if (smsSection) summary += smsSection + "\n";
  if (emailSection) summary += emailSection;

  await sendTelegram(summary);
  console.log(`[relay] Sent summary to Telegram (${allEmails.length} emails)`);

  // Trim seen sets
  for (const s of [seenEmails, seenSms]) {
    if (s.size > 5000) {
      const arr = [...s];
      s.clear();
      for (const item of arr.slice(-2500)) s.add(item);
    }
  }
}

// ── Tunnel URL + SMS webhook registration ─────────────────────────────────────

let lastRegisteredWebhookUrl = "";

function getTunnelUrl() {
  const manual = process.env.TUNNEL_URL || process.env.SMS_WEBHOOK_URL;
  if (manual) return manual;
  try {
    return fs.readFileSync("/tmp/tunnel-url", "utf8").trim();
  } catch { return ""; }
}

function ensureSmsWebhook() {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;

  const base = getTunnelUrl();
  if (!base) return; // tunnel not up yet, skip silently

  const webhookUrl = base + "/sms";
  if (webhookUrl === lastRegisteredWebhookUrl) return; // already registered this URL

  smsApi("POST", "/api/3rdparty/v1/webhooks", {
    url: webhookUrl,
    event: "sms:received",
  });
  lastRegisteredWebhookUrl = webhookUrl;
  console.log(`[relay] Registered SMS webhook: ${webhookUrl}`);
}

// ── Start ────────────────────────────────────────────────────────────────────

server.listen(WEBHOOK_PORT, "0.0.0.0", () => {
  console.log(`[relay] Webhook listener on port ${WEBHOOK_PORT}, polling every ${POLL_INTERVAL / 1000}s`);
});

setTimeout(poll, 15000);
setInterval(poll, POLL_INTERVAL);
