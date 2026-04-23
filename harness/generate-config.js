const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const CONFIG_PATH = process.env.OPENCLAW_CONFIG_PATH?.trim()
  ? path.resolve(process.env.OPENCLAW_CONFIG_PATH.trim())
  : "/home/clawuser/.openclaw/openclaw.json";
const WORKSPACE = process.env.OPENCLAW_WORKSPACE_DIR?.trim()
  ? path.resolve(process.env.OPENCLAW_WORKSPACE_DIR.trim())
  : "/home/clawuser/workspace";
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

function resolveTemplate(str) {
  if (typeof str !== "string") return str;
  return str.replace(/\{\{(\w+)\}\}/g, (_, name) => env(name) || "");
}

// ── Load models.json ─────────────────────────────────────────────────────────

const modelsJsonPath = path.join(SCRIPT_DIR, "..", "models.json");
let modelsJson;
try {
  modelsJson = JSON.parse(fs.readFileSync(modelsJsonPath, "utf8"));
} catch (err) {
  console.error(`ERROR: Failed to parse models.json: ${err.message}`);
  console.error("  If starting fresh, copy models.example.json → models.json and add your keys.");
  process.exit(1);
}

// CONTEXT_TOKENS env var: if set to a valid int, cap ALL models to that.
// If unset, each model uses its own contextWindow from models.json.
const globalContextCap = envInt("CONTEXT_TOKENS");

// ── Build providers from models.json ─────────────────────────────────────────

const providers = {};
const modelAliases = {};
const modelRefsByKey = {};
let visionModelRef = null;

for (const [key, cfg] of Object.entries(modelsJson.providers)) {
  const { model, api, contextWindow: ctxWindow } = cfg;
  const apiKey = resolveTemplate(cfg.apiKey);
  const baseUrl = resolveTemplate(cfg.baseUrl);

  if (!model || !api) { console.warn(`  SKIP ${key}: missing model or api`); continue; }
  if (!apiKey) {
    const hint = cfg.apiKey?.match(/\{\{(\w+)\}\}/)?.[1];
    console.warn(`  SKIP ${key}: missing apiKey${hint ? ` (set ${hint} in .env)` : ""}`);
    continue;
  }

  const providerName = cfg.provider;
  // If global cap is set, cap this model. Otherwise use its own window.
  const effectiveCtx = globalContextCap
    ? Math.min(ctxWindow || globalContextCap, globalContextCap)
    : (ctxWindow || 128000);

  const modelDef = {
    id: model, name: model,
    reasoning: cfg.reasoning !== undefined ? cfg.reasoning : /([-:_.])(r1|reason|reasoning|think)([-:_.]|$)/i.test(model),
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
      ...(cfg.headers && typeof cfg.headers === "object" ? { headers: cfg.headers } : {}),
      models: [],
    };
  }

  // Two provider entries with the same provider + model resolve to one
  // modelRef. Push the model definition only on first sight, and fail loudly
  // if a later entry claims a different alias — that would silently clobber.
  const existing = providers[providerName].models.find(m => m.id === modelDef.id);
  if (!existing) providers[providerName].models.push(modelDef);
  else if (modelAliases[modelRef]?.alias && modelAliases[modelRef].alias !== (cfg.alias || key)) {
    console.warn(`  WARNING: ${key} collides with existing alias '${modelAliases[modelRef].alias}' for ${modelRef}; keeping the first alias. Collapse the duplicate provider entry in models.json.`);
    continue;
  }

  modelAliases[modelRef] = { alias: cfg.alias || key };
  if (cfg.params && typeof cfg.params === "object") {
    modelAliases[modelRef].params = cfg.params;
  }

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
if (heartbeatKey && !modelRefsByKey[heartbeatKey]) {
  console.warn(`  WARNING: heartbeatModel "${heartbeatKey}" not available, using ${heartbeatModel}`);
}

// Effective context for pruning = global cap or smallest model window
const allWindows = Object.values(providers).flatMap(p => p.models.map(m => m.contextWindow));
const effectiveContextTokens = globalContextCap || Math.min(...allWindows);

// ── Browser ──────────────────────────────────────────────────────────────────
// Browser tools are provided by the @askjo/camofox-browser plugin
// (configured below under plugins.entries). The legacy Chromium/CDP browser
// subsystem is disabled — camofox registers its own tool surface.

const mcpConfig = buildMcpServers();
const browser = { enabled: false };

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
  "openclaw-memory", "himalaya", "summarize",
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
  // threadBindings.spawnSubagentSessions enables subagent spawning from this channel.
  // We put it inside threadBindings because some channel schemas (e.g. Telegram)
  // reject top-level spawnSubagentSessions as an additionalProperty.
  const subagentSupport = { threadBindings: { spawnSubagentSessions: true } };
  if (env("TELEGRAM_BOT_TOKEN")) ch.telegram = { enabled: true, ...subagentSupport, ...dmPolicy("TELEGRAM_ALLOW_FROM") };
  if (env("SIGNAL_NUMBER")) ch.signal = { enabled: true, ...subagentSupport, account: env("SIGNAL_NUMBER"), cliPath: "signal-cli", ...dmPolicy("SIGNAL_ALLOW_FROM") };
  if (env("TWILIO_ACCOUNT_SID") && env("TWILIO_AUTH_TOKEN") && env("TWILIO_PHONE_NUMBER"))
    ch.twilio = { enabled: true, ...subagentSupport, accountSid: env("TWILIO_ACCOUNT_SID"), authToken: env("TWILIO_AUTH_TOKEN"), phoneNumber: env("TWILIO_PHONE_NUMBER"), ...dmPolicy("TWILIO_ALLOW_FROM") };
  return Object.keys(ch).length > 0 ? { channels: ch } : {};
}

function resolveObj(obj) {
  if (typeof obj === "string") return resolveTemplate(obj);
  if (Array.isArray(obj)) return obj.map(resolveObj);
  if (obj && typeof obj === "object") {
    return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, resolveObj(v)]));
  }
  return obj;
}

function buildMcpServers() {
  const servers = {};
  const proxyScript = path.join(SCRIPT_DIR, "mcp-http-proxy.js");

  for (const [name, cfg] of Object.entries(modelsJson.mcpServers || {})) {
    let serverConfig = null;

    if (cfg.command) {
      serverConfig = {
        command: cfg.command,
        args: resolveObj(cfg.args || []),
        ...(cfg.env ? { env: resolveObj(cfg.env) } : {}),
      };
    } else if (cfg.url) {
      const resolvedUrl = resolveTemplate(cfg.url);
      const resolvedAuth = cfg.auth ? resolveTemplate(cfg.auth) : "";
      const args = [proxyScript, resolvedUrl, resolvedAuth];
      if (cfg.oauthFile) args.push(cfg.oauthFile);
      serverConfig = { command: "node", args };
    }

    if (!serverConfig) continue;
    if (cfg.description) serverConfig.description = cfg.description;
    servers[name] = serverConfig;
  }

  return Object.keys(servers).length > 0 ? { mcp: { servers } } : {};
}

// ── Assemble config ──────────────────────────────────────────────────────────

// Generate a persistent gateway token if not provided via env.
// Token auth gives connecting clients (CLI, Control UI) full operator scopes,
// avoiding "missing scope: operator.read" errors that occur with auth mode "none".
const gatewayToken = env("OPENCLAW_GATEWAY_TOKEN") || generatePersistentToken();

function generatePersistentToken() {
  // Re-use an existing auto-generated token so we don't invalidate CLI sessions on every regen
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (existing.gateway?.auth?.token && existing.gateway.auth.mode === "token") {
      return existing.gateway.auth.token;
    }
  } catch {}
  return crypto.randomBytes(32).toString("base64url");
}

const config = {
  gateway: {
    mode: "local",
    auth: { mode: "token", token: gatewayToken },
    remote: { token: gatewayToken },
    controlUi: {
      dangerouslyDisableDeviceAuth: true,
      allowInsecureAuth: true,
    },
  },
  tools: {
    exec: {
      security: "full",
      ask: "off",
    },
    elevated: {
      enabled: true,
      allowFrom: { "*": ["*"] },
    },
  },
  browser,
  ...mcpConfig,
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
      subagents: { model: heartbeatModel, maxConcurrent: 8, allowAgents: ["*"], maxSpawnDepth: 2, maxChildrenPerAgent: 10 },
      contextPruning: { mode: "cache-ttl", ttl: "1h" },
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 40000,
        memoryFlush: {
          enabled: true, softThresholdTokens: 8000,
          prompt: "Save decisions, facts, and open questions to memory/daily.md. Reply NO_REPLY if nothing to store.",
        },
      },
      maxConcurrent: 8,
    },
  },
  ...buildChannels(),
  plugins: {
    entries: {
      "camofox-browser": {
        enabled: true,
        config: {
          url: "http://127.0.0.1:9377",
          autoStart: true,
          maxSessions: 5,
          maxTabsPerSession: 3
        }
      }
    }
  },
  meta: { lastTouchedVersion: "2026.3.30", lastTouchedAt: new Date().toISOString() },
};

// Preserve plugins.allow from existing config so manual trust settings survive regen
let existingConfig = {};
try {
  existingConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
} catch {}
if (existingConfig.plugins?.allow) {
  config.plugins = config.plugins || {};
  config.plugins.allow = existingConfig.plugins.allow;
}

fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf8");
fs.writeFileSync(path.join(WORKSPACE, "SYSTEM.md"), systemPrompt + "\n", "utf8");

// ── Log ──────────────────────────────────────────────────────────────────────

console.log(`Generated ${CONFIG_PATH}`);
console.log(`  Chain:     ${[primary, ...fallbacks].join(" -> ")}`);
console.log(`  Vision:    ${visionModelRef || "-"}`);
console.log(`  Heartbeat: ${heartbeatModel}`);
console.log(`  Context:   ${effectiveContextTokens.toLocaleString()} tokens${globalContextCap ? " (global cap)" : " (per-model min)"}`);
console.log(`  Auth:      ${config.gateway.auth.mode}${config.gateway.auth.mode === "token" ? " (operator scopes enabled)" : " (WARNING: no operator scopes)"}`);
console.log(`  Cache:     ${Object.entries(providers).filter(([, p]) => p.params?.cacheControlTtl).map(([k]) => k).join(", ") || "none"} (ttl=1h)`);
console.log(`  Browser:   camofox-browser plugin (auto-start at ${config.plugins?.entries?.["camofox-browser"]?.config?.url || "http://127.0.0.1:9377"})`);
console.log(`  MCP:       ${Object.keys(mcpConfig.mcp?.servers || {}).join(", ") || "none"}`);
console.log(`  Providers: ${Object.keys(providers).join(", ")}`);
