#!/usr/bin/env node
// Message relay — forwards new emails and SMS to OpenClaw.
//
// SMS: webhook on port 18790 receives incoming texts from Android SMS
// Gateway → each message is appended to per-contact history and dispatched
// to the agent as soon as a short debounce window expires (live).
//
// Email: himalaya (IMAP) and gog (Gmail) are polled every 2 minutes,
// filtered to unread only. First poll primes the "seen" sets without
// notifying the agent so old mail isn't re-delivered on every restart.
//
// Env vars:
//   SMS_GATEWAY_URL / SMS_GATEWAY_USERNAME / SMS_GATEWAY_PASSWORD
//   GOG_KEYRING_PASSWORD  — needed to unlock gog's token store
//   RELAY_PORT (default 18790) / RELAY_POLL_INTERVAL (default 120000)
//   SMS_DEBOUNCE_MS (default 5000)
//
// Email accounts are discovered dynamically:
//   himalaya  — `himalaya account list -o json`
//   gmail     — `gog auth list -j`, filtered to accounts with gmail service
// Adding a new account via `himalaya` TOML or `gog auth add` is picked up on
// the next poll without a relay restart.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execSync, execFileSync } = require("node:child_process");

const SMS_URL = process.env.SMS_GATEWAY_URL;
const SMS_USER = process.env.SMS_GATEWAY_USERNAME;
const SMS_PASS = process.env.SMS_GATEWAY_PASSWORD;
const WEBHOOK_PORT = Number.parseInt(process.env.RELAY_PORT || "18790", 10);
const POLL_INTERVAL = Number.parseInt(process.env.RELAY_POLL_INTERVAL || "120000", 10);
const SMS_DEBOUNCE_MS = Number.parseInt(process.env.SMS_DEBOUNCE_MS || "5000", 10);
const SMS_HISTORY_DIR = process.env.OPENCLAW_WORKSPACE_DIR
  ? path.join(process.env.OPENCLAW_WORKSPACE_DIR, "sms")
  : "/Users/leonl/openclaw-workspace/sms";

const seenEmails = new Set();
const seenSms = new Set();
const pendingSms = [];
let emailPrimed = false;
let smsDispatchTimer = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function run(cmd) {
  try { return execSync(cmd, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] }).trim(); }
  catch (e) {
    console.error("[relay] run failed:", cmd.slice(0, 80), "→", (e.stderr?.toString() || e.message || "").slice(0, 200));
    return "";
  }
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

function formatAddr(addr) {
  if (!addr) return "unknown";
  if (typeof addr === "string") return addr;
  if (Array.isArray(addr)) return addr.map(formatAddr).join(", ");
  return addr.name ? `${addr.name} <${addr.addr}>` : (addr.addr || "unknown");
}

// ── SMS history ──────────────────────────────────────────────────────────────
// One text file per phone number at /Users/leonl/openclaw-workspace/sms/<number>.txt
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

  // Avoid duplicate lines (check last 5) — fresh file is always a first write.
  if (fs.existsSync(file)) {
    const lastLines = fs.readFileSync(file, "utf8").trim().split("\n").slice(-5);
    if (lastLines.some(l => l.includes(text.slice(0, 40)))) return;
  }

  fs.appendFileSync(file, line, "utf8");
}

// Also track outbound messages sent via the SMS Gateway API
function pollSentMessages() {
  const raw = smsApi("GET", "/3rdparty/v1/message?limit=20");
  if (!raw) return;
  let messages;
  try { messages = JSON.parse(raw); }
  catch (e) { console.error("[relay] pollSentMessages parse error:", e.message, "raw:", raw.slice(0, 120)); return; }
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
}

// ── SMS live dispatch ────────────────────────────────────────────────────────
// Webhook drops into pendingSms and schedules a dispatch. Quick-fire texts
// coalesce into a single agent turn within SMS_DEBOUNCE_MS.

function scheduleSmsDispatch() {
  if (smsDispatchTimer) clearTimeout(smsDispatchTimer);
  smsDispatchTimer = setTimeout(() => {
    smsDispatchTimer = null;
    const section = buildSmsSection();
    if (!section) return;
    sendToAgent("New SMS:\n\n" + section);
    console.log("[relay] Live SMS dispatched to agent");
  }, SMS_DEBOUNCE_MS);
}

function buildSmsSection() {
  if (pendingSms.length === 0) return "";
  const bySender = {};
  for (const msg of pendingSms) {
    if (!bySender[msg.sender]) bySender[msg.sender] = [];
    bySender[msg.sender].push(msg);
  }
  const lines = [];
  for (const [sender, msgs] of Object.entries(bySender)) {
    lines.push(`From ${sender}:`);
    for (const m of msgs) {
      const time = m.time.slice(11, 16);
      lines.push(`  [${time}] ${m.text.slice(0, 300)}`);
    }
    lines.push(`  (full history: ${path.join(SMS_HISTORY_DIR, sanitizeNumber(sender) + ".txt")})`);
  }
  pendingSms.length = 0;
  return lines.join("\n");
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

    let newCount = 0;
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
        newCount++;
      }
    }

    if (newCount > 0) scheduleSmsDispatch();
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
  if (!fs.existsSync("/tmp/tunnel-url")) return "";
  return fs.readFileSync("/tmp/tunnel-url", "utf8").trim();
}

function cleanupStaleWebhooks(currentUrl) {
  if (!SMS_URL || !SMS_USER || !SMS_PASS) return;
  const listRaw = smsApi("GET", "/3rdparty/v1/webhooks");
  if (!listRaw) return;
  let hooks;
  try { hooks = JSON.parse(listRaw); }
  catch (e) { console.error("[relay] cleanupStaleWebhooks parse error:", e.message, "raw:", listRaw.slice(0, 120)); return; }
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
  try { devices = JSON.parse(devicesRaw); }
  catch (e) { console.error("[relay] triggerSmsExport parse error:", e.message, "raw:", devicesRaw.slice(0, 120)); return; }
  const deviceId = Array.isArray(devices) ? devices[0]?.id : devices?.id;
  if (!deviceId) { console.log("[relay] No SMS device found"); return; }
  const since = new Date(Date.now() - 600000).toISOString();
  const until = new Date().toISOString();
  const exportResult = smsApi("POST", "/3rdparty/v1/messages/inbox/export", { deviceId, since, until });
  console.log(`[relay] Export triggered for device ${deviceId} (${since.slice(11,19)} - ${until.slice(11,19)}) → ${exportResult || "(202 accepted)"}`);
}

// ── Email polling ────────────────────────────────────────────────────────────
// Both pollers filter to UNREAD only, so we don't re-deliver already-read
// mail after a relay restart.

// Envelope/thread list is fast; do NOT read bodies — each `message read` is
// 2-15s of IMAP and a batch of 20 would block the relay for minutes. The
// agent can fetch specific bodies on demand via the himalaya / gog skills.

function listHimalayaAccounts() {
  const out = run("himalaya account list -o json");
  if (!out) return [];
  try { return JSON.parse(out).map(a => a.name).filter(Boolean); }
  catch (e) { console.error("[relay] listHimalayaAccounts parse error:", e.message); return []; }
}

function listGogGmailAccounts() {
  const out = run("gog auth list -j");
  if (!out) return [];
  try {
    const data = JSON.parse(out);
    return (data.accounts || [])
      .filter(a => a.email && Array.isArray(a.services) && a.services.includes("gmail"))
      .map(a => a.email);
  } catch (e) { console.error("[relay] listGogGmailAccounts parse error:", e.message); return []; }
}

function pollHimalayaAccount(account) {
  const flag = account ? `-a ${account}` : "";
  const out = run(`himalaya envelope list ${flag} --page-size 20 --output json "not flag seen"`);
  if (!out) return [];
  let envelopes;
  try { envelopes = JSON.parse(out); }
  catch (e) { console.error(`[relay] pollHimalaya(${account}) parse error:`, e.message, "raw:", out.slice(0, 120)); return []; }
  const results = [];
  for (const e of envelopes) {
    const key = `h:${account}:${e.id}`;
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    results.push({
      source: `himalaya/${account}`,
      id: e.id,
      from: formatAddr(e.from),
      subject: e.subject || "(no subject)",
      date: e.date || "",
    });
  }
  return results;
}

function pollGogAccount(email) {
  const out = run(`gog gmail search "is:unread" --max 20 -j --account ${email}`);
  if (!out) return [];
  let payload;
  try { payload = JSON.parse(out); }
  catch (e) { console.error(`[relay] pollGog(${email}) parse error:`, e.message, "raw:", out.slice(0, 120)); return []; }
  const threads = Array.isArray(payload) ? payload : (payload.threads || payload.messages || []);
  const results = [];
  for (const msg of threads) {
    const id = msg.id || msg.threadId || msg.messageId;
    if (!id) continue;
    const key = `g:${email}:${id}`;
    if (seenEmails.has(key)) continue;
    seenEmails.add(key);
    results.push({
      source: `gmail/${email}`,
      id,
      from: formatAddr(msg.from || msg.sender),
      subject: msg.subject || "(no subject)",
      snippet: (msg.snippet || "").slice(0, 200),
      date: msg.internalDate || msg.date || "",
    });
  }
  return results;
}

function pollAllEmail() {
  const results = [];
  for (const acct of listHimalayaAccounts()) results.push(...pollHimalayaAccount(acct));
  for (const email of listGogGmailAccounts()) results.push(...pollGogAccount(email));
  return results;
}

function buildEmailSection(emails) {
  if (emails.length === 0) return "";
  const lines = [];
  for (const e of emails) {
    lines.push(`[${e.source} #${e.id}] ${e.from} — ${e.subject}`);
    if (e.snippet) lines.push(`  ${e.snippet}...`);
  }
  return lines.join("\n");
}

// ── Main poll cycle (email only; SMS is delivered live via webhook) ──────────

async function poll() {
  console.log("[relay] Polling...");

  ensureSmsWebhook();
  triggerSmsExport();
  pollSentMessages(); // track outbound SMS for history

  const emails = pollAllEmail();
  const emailSection = buildEmailSection(emails);

  // First poll after startup only primes dedup sets, doesn't notify.
  // Prevents flooding the agent with already-read mail after a relay restart.
  if (!emailPrimed) {
    emailPrimed = true;
    console.log(`[relay] Primed ${emails.length} unread email(s); not dispatching on startup`);
    return;
  }

  if (!emailSection) {
    console.log("[relay] No new email");
  } else {
    sendToAgent("New email:\n\n" + emailSection);
    console.log(`[relay] ${emails.length} email(s) dispatched to agent`);
  }

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
  const himAccts = listHimalayaAccounts();
  const gogAccts = listGogGmailAccounts();
  console.log(`[relay] Webhook listener on port ${WEBHOOK_PORT}; SMS live (${SMS_DEBOUNCE_MS}ms debounce), email every ${POLL_INTERVAL / 1000}s`);
  console.log(`[relay] SMS Gateway: ${SMS_URL ? "enabled" : "disabled (no SMS_GATEWAY_URL)"}`);
  console.log(`[relay] Himalaya accounts: ${himAccts.length ? himAccts.join(", ") : "(none)"}`);
  console.log(`[relay] Gmail accounts:    ${gogAccts.length ? gogAccts.join(", ") : "(none)"}`);
  console.log(`[relay] SMS history: ${SMS_HISTORY_DIR}`);
  console.log(`[relay] Tunnel: ${getTunnelUrl() || "waiting..."}`);
});

setTimeout(poll, 15000);
setInterval(poll, POLL_INTERVAL);
