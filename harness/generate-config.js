const fs = require("node:fs");
const path = require("node:path");

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH?.trim()
  ? path.resolve(process.env.OPENCLAW_CONFIG_PATH.trim())
  : "/home/clawuser/.openclaw/openclaw.json";
const WORKSPACE = "/home/clawuser/workspace";
const SCRIPT_DIR = __dirname;

// ── Helpers ──────────────────────────────────────────────────────────────────

function env(name) {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  if (!trimmed) return undefined;
  if (/^your-|^change-me|^placeholder/i.test(trimmed)) return undefined;
  return trimmed;
}

function envInt(name) {
  const raw = env(name);
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

// ── Load models.json ─────────────────────────────────────────────────────────

const modelsJsonPath = path.join(SCRIPT_DIR, "..", "models.json");
const modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));

// CONTEXT_TOKENS env var: if set to a valid int, cap ALL models to that.
// If unset, each model uses its own contextWindow from models.json.
const globalContextCap = envInt("CONTEXT_TOKENS");

// ── Build providers from models.json ─────────────────────────────────────────

const providers = {};
const modelAliases = {};
const modelRefsByKey = {};
let visionModelRef = null;

for (const [key, cfg] of Object.entries(modelsJson.providers)) {
  const { apiKey, model, baseUrl, api, contextWindow: ctxWindow } = cfg;

  if (!model || !api) continue;
  if (!apiKey) continue;

  const providerName = cfg.provider;
  // If global cap is set, cap this model. Otherwise use its own window.
  const effectiveCtx = globalContextCap
    ? Math.min(ctxWindow || globalContextCap, globalContextCap)
    : (ctxWindow || 128000);

  const modelDef = {
    id: model, name: model,
    reasoning: /([-:_.])(r1|reason|reasoning|think)([-:_.]|$)/i.test(model),
    input: cfg.input || ["text"],
    cost: cfg.cost || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: effectiveCtx,
  };

  const modelRef = `${providerName}/${model}`;
  modelRefsByKey[key] = modelRef;

  if (cfg.vision && !visionModelRef) visionModelRef = modelRef;

  if (!providers[providerName]) {
    providers[providerName] = {
      ...(baseUrl ? { baseUrl: baseUrl.replace(/\/+$/, "") } : {}),
      api,
      ...(apiKey ? { apiKey } : {}),
      models: [],
    };
  }
  providers[providerName].models.push(modelDef);

  modelAliases[modelRef] = { alias: cfg.alias || key };

  if (cfg.extras?.upgradeModel) {
    const upModel = cfg.extras.upgradeModel;
    const upRef = `${providerName}/${upModel}`;
    const upCtx = globalContextCap
      ? Math.min(cfg.extras.upgradeContextWindow || globalContextCap, globalContextCap)
      : (cfg.extras.upgradeContextWindow || 200000);
    providers[providerName].models.push({
      id: upModel, name: upModel, reasoning: false,
      input: cfg.input || ["text"],
      cost: cfg.extras.upgradeCost || cfg.cost,
      contextWindow: upCtx,
    });
    modelAliases[upRef] = { alias: cfg.extras.upgradeAlias || "upgrade" };
  }
}

// ── Model order ──────────────────────────────────────────────────────────────

const order = modelsJson.order || [];
const ordered = order.map(k => modelRefsByKey[k]).filter(Boolean);

if (ordered.length === 0) {
  console.error("ERROR: No models configured. Check models.json order + .env API keys.");
  process.exit(1);
}

const primary = ordered[0];
const fallbacks = ordered.slice(1);
// Heartbeat model: explicit from models.json, or last in chain (cheapest)
const heartbeatKey = modelsJson.heartbeatModel;
const heartbeatModel = (heartbeatKey && modelRefsByKey[heartbeatKey]) || ordered.at(-1);

// Effective context for pruning = global cap or smallest model window
const allWindows = Object.values(providers).flatMap(p => p.models.map(m => m.contextWindow));
const effectiveContextTokens = globalContextCap || Math.min(...allWindows);

// ── Browser ──────────────────────────────────────────────────────────────────
// Capsolver extension is loaded by stealth-browser.js at Chrome launch time.

const cdpUrl = env("OPENCLAW_BROWSER_CDP_URL");
const browser = {
  enabled: true,
  defaultProfile: cdpUrl ? "stealth" : "managed",
  headless: true, noSandbox: true,
  ssrfPolicy: { dangerouslyAllowPrivateNetwork: true },
  profiles: {
    managed: { cdpPort: 18800, color: "#0066CC" },
    ...(cdpUrl ? { stealth: { cdpUrl, attachOnly: true, color: "#FF4500" } } : {}),
  },
  remoteCdpTimeoutMs: 15000, remoteCdpHandshakeTimeoutMs: 15000,
};

// ── Skills ───────────────────────────────────────────────────────────────────

const SKILLS_DST = path.join(WORKSPACE, "skills");
const BUNDLED_SKILLS = path.join(__dirname, "..", "skills");

function ensureSkillFile(name, content) {
  const f = path.join(SKILLS_DST, name, "SKILL.md");
  if (fs.existsSync(f)) return;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content, "utf8");
}
function patchFrontmatter(name, desc) {
  const dir = path.join(SKILLS_DST, name);
  const f = path.join(dir, "SKILL.md");
  if (!fs.existsSync(dir)) return;
  const fm = `---\nname: ${name}\ndescription: ${desc}\n---\n`;
  if (!fs.existsSync(f)) { fs.writeFileSync(f, fm, "utf8"); return; }
  if (!fs.readFileSync(f, "utf8").startsWith("---")) fs.writeFileSync(f, fm + "\n" + fs.readFileSync(f, "utf8"), "utf8");
}
if (fs.existsSync(BUNDLED_SKILLS)) {
  for (const e of fs.readdirSync(BUNDLED_SKILLS, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const src = path.join(BUNDLED_SKILLS, e.name, "SKILL.md");
    if (fs.existsSync(src)) ensureSkillFile(e.name, fs.readFileSync(src, "utf8"));
  }
}
patchFrontmatter("vapi", "Manage Vapi voice AI agents and outbound calls.");
patchFrontmatter("openclaw-memory", "Persistent memory system for OpenClaw.");

function skillEnv(vars) {
  const out = {};
  for (const [k] of vars) { const v = env(k); if (v) out[k] = v; }
  return Object.keys(out).length > 0 ? { env: out } : {};
}
const simpleSkills = [
  "humanizer", "filesystem", "cron", "jina-reader", "HTTP",
  "openclaw-memory", "ddg-search", "himalaya", "summarize",
  "pdf", "weather", "github", "skill-vetter", "find-skills",
];
const skillEntries = Object.fromEntries(simpleSkills.map(s => [s, { enabled: true }]));
Object.assign(skillEntries, {
  "vapi": { enabled: true, ...(env("VAPI_API_KEY") ? { apiKey: env("VAPI_API_KEY") } : {}), ...skillEnv([["VAPI_API_KEY"]]) },
  "tavily-search": { enabled: true, ...skillEnv([["TAVILY_API_KEY"]]) },
  "reclaim": { enabled: true, ...skillEnv([["RECLAIM_API_KEY"]]) },
  "sms-gateway": { enabled: true, ...skillEnv([["SMS_GATEWAY_URL"], ["SMS_GATEWAY_USERNAME"], ["SMS_GATEWAY_PASSWORD"]]) },
  "google-health": { enabled: true },
});

// ── System prompt ────────────────────────────────────────────────────────────

const ownerName = env("OWNER_NAME") || "the user";
const ownerEmail = env("OWNER_EMAIL") || "";
const systemPrompt = fs.readFileSync(path.join(SCRIPT_DIR, "..", "prompts", "SYSTEM.md"), "utf8")
  .replaceAll("{{OWNER_NAME}}", ownerName)
  .replaceAll("{{OWNER_EMAIL}}", ownerEmail)
  .trim();

// ── Channels ─────────────────────────────────────────────────────────────────

function dmPolicy(allowFromEnv) {
  const raw = env(allowFromEnv);
  if (!raw) return { dmPolicy: "pairing" };
  return { dmPolicy: "allowlist", allowFrom: raw.split(",").map(s => s.trim()) };
}

function buildChannels() {
  const ch = {};
  if (env("TELEGRAM_BOT_TOKEN")) ch.telegram = { enabled: true, ...dmPolicy("TELEGRAM_ALLOW_FROM") };
  if (env("SIGNAL_NUMBER")) ch.signal = { enabled: true, account: env("SIGNAL_NUMBER"), cliPath: "signal-cli", ...dmPolicy("SIGNAL_ALLOW_FROM") };
  if (env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("TWILIO_PHONE_NUMBER"))
    ch.twilio = { enabled: true, accountSid: env("TWILIO_ACCOUNT_SID"), authToken: env("TWILIO_AUTH_TOKEN"), phoneNumber: env("TWILIO_PHONE_NUMBER"), ...dmPolicy("TWILIO_ALLOW_FROM") };
  return Object.keys(ch).length > 0 ? { channels: ch } : {};
}

// ── Template resolver ────────────────────────────────────────────────────────
// Replace {{VAR}} with the value from process.env, or from provider apiKeys in
// models.json. Works on any string value anywhere in the MCP config.

function resolveTemplate(str) {
  if (typeof str !== "string") return str;
  return str.replaceAll(/\{\{(\w+)\}\}/g, (_, varName) => {
    // Check process.env first
    const fromEnv = env(varName);
    if (fromEnv) return fromEnv;
    // Check provider apiKeys (e.g., {{ANTHROPIC_API_KEY}} finds the anthropic provider's key)
    for (const p of Object.values(modelsJson.providers)) {
      if (p.apiKey && varName.toLowerCase().includes(p.provider)) return p.apiKey;
    }
    return "";
  });
}

function resolveObj(obj) {
  if (typeof obj === "string") return resolveTemplate(obj);
  if (Array.isArray(obj)) return obj.map(resolveObj);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveObj(v)]));
  }
  return obj;
}

// ── MCP servers ──────────────────────────────────────────────────────────────
// OpenClaw only supports stdio MCP servers. For remote HTTP endpoints, we spawn
// a local proxy (mcp-http-proxy.js) that bridges stdio <-> HTTP.

const proxyScript = path.join(SCRIPT_DIR, "mcp-http-proxy.js");
const mcpServers = {};

if (modelsJson.mcpServers) {
  for (const [name, cfg] of Object.entries(modelsJson.mcpServers)) {
    if (cfg.command) {
      // Native stdio server — resolve {{VAR}} templates in env and args
      mcpServers[name] = {
        command: cfg.command,
        args: resolveObj(cfg.args || []),
        ...(cfg.env ? { env: resolveObj(cfg.env) } : {}),
      };
    } else if (cfg.url) {
      // Remote HTTP server — proxy via stdio bridge, resolve templates in url/auth
      const resolvedUrl = resolveTemplate(cfg.url);
      const resolvedAuth = cfg.auth ? resolveTemplate(cfg.auth) : undefined;
      const args = [proxyScript, resolvedUrl];
      if (resolvedAuth) args.push(resolvedAuth);
      else args.push(""); // placeholder so oauthFile is arg[4]
      if (cfg.oauthFile) args.push(cfg.oauthFile);
      mcpServers[name] = {
        command: "node",
        args,
      };
    }
    if (mcpServers[name]) {
      console.log(`  MCP: ${name}${cfg.url ? " (proxied from " + cfg.url + ")" : ""}`);
    }
  }
}

// ── Assemble config ──────────────────────────────────────────────────────────

const config = {
  gateway: {
    mode: "local",
    auth: { mode: "none" },
  },
  browser,
  ...(Object.keys(mcpServers).length > 0 ? { mcp: { servers: mcpServers } } : {}),
  skills: {
    load: { watch: true, watchDebounceMs: 250, extraDirs: [`${WORKSPACE}/skills`] },
    entries: skillEntries,
  },
  ...(Object.keys(providers).length > 0 ? { models: { mode: "merge", providers } } : {}),
  agents: {
    defaults: {
      workspace: WORKSPACE,
      models: modelAliases,
      model: { primary, fallbacks },
      ...(visionModelRef ? { imageModel: { primary: visionModelRef } } : {}),
      heartbeat: { every: "30m", model: heartbeatModel },
      subagents: { model: heartbeatModel, maxConcurrent: 2 },
      contextPruning: { mode: "cache-ttl", ttl: "1h" },
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 40000,
        memoryFlush: {
          enabled: true, softThresholdTokens: 8000,
          prompt: "Save decisions, facts, and open questions to memory/daily.md. Reply NO_REPLY if nothing to store.",
        },
      },
      maxConcurrent: 4,
    },
  },
  ...buildChannels(),
  meta: { lastTouchedVersion: "2026.3.30", lastTouchedAt: new Date().toISOString() },
};

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(WORKSPACE, "SYSTEM.md"), systemPrompt + "\n", "utf8");

// ── Log ──────────────────────────────────────────────────────────────────────

console.log(`Generated ${CONFIG_PATH}`);
console.log(`  Chain:     ${[primary, ...fallbacks].join(" -> ")}`);
console.log(`  Vision:    ${visionModelRef || "-"}`);
console.log(`  Heartbeat: ${heartbeatModel}`);
console.log(`  Context:   ${effectiveContextTokens.toLocaleString()} tokens${globalContextCap ? " (global cap)" : " (per-model min)"}`);
console.log(`  Cache:     ${Object.entries(providers).filter(([, p]) => p.params?.cacheControlTtl).map(([k]) => k).join(", ") || "none"} (ttl=1h)`);
console.log(`  Browser:   ${cdpUrl ? "stealth + managed" : "managed only"}`);
console.log(`  Providers: ${Object.keys(providers).join(", ")}`);
