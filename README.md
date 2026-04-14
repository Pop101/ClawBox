# ClawBox - Fully Containerized Instant Image

A fully self-contained OpenClaw deployment that acts as a personal AI assistant with real-world agency. Talk to it on Telegram — it handles email, SMS, phone calls, web browsing, scheduling, coding, and more.

## What's inside

### Core infrastructure
- **Multi-model failover** — models defined in `models.json` with automatic fallback chain. Supports Anthropic, OpenRouter, Google Gemini, local llama.cpp, and any OpenAI-compatible API. Swap providers by editing one file.
- **Process management** — supervisord manages 6 services (gateway, stealth browser, relay, tunnel, tunnel-watcher, MCP setup) with auto-restart and health checks.
- **Cloudflare Tunnel** — auto-provisioned quick tunnel exposes the SMS webhook port without a public IP or port forwarding. Tunnel URL auto-detected and registered.
- **Cost controls** — prompt caching, context pruning, quiet hours, heartbeat on cheapest model. `CONTEXT_TOKENS` env var to globally cap context window size.

### Browser & web
- **Stealth browser** — headless Chromium via Playwright + puppeteer-extra with anti-fingerprinting (stealth plugin), custom user-agent, and persistent profiles. Managed by a watchdog that auto-restarts on crash.
- **Capsolver captcha solving** — Chrome extension auto-loaded at boot. Solves reCAPTCHA v2/v3, hCaptcha, Cloudflare Turnstile, DataDome, and AWS WAF automatically on every page load. No manual API calls needed.
- **Credential lookup** — agent reads saved passwords from CSV exports in `/home/clawuser/credentials/` and uses them directly in the browser. Never echoes passwords in chat.

### Communication
- **Telegram** — primary chat interface. Allowlist-based access control via `TELEGRAM_ALLOW_FROM`.
- **Email (himalaya)** — IMAP/SMTP email via himalaya CLI. Read, send, reply, forward, search.
- **Gmail (gog)** — Google Workspace email via gog CLI. Separate from himalaya — agent checks both mailboxes.
- **SMS (Android SMS Gateway)** — read and send texts from your Android phone. Full conversation history stored per-contact at `/home/clawuser/workspace/sms/`.
- **Voice calls (Vapi)** — outbound phone calls with custom system prompts per call. Agent speaks as the owner.
- **Signal** — E2E encrypted messaging via signal-cli.
- **SMS/email relay** — background service polls for new messages every 2 minutes, batches them with conversation context, and forwards summaries to the active agent session.

### Scheduling & productivity
- **Google Calendar** — view, create, and delete events via gog CLI.
- **Google Tasks** — to-do lists with deadlines via gog CLI.
- **Reclaim.ai** — smart auto-scheduling of tasks and habits on Google Calendar via REST API.
- **Cron skill** — schedule recurring agent-side tasks (daily email check, weekly reports, etc.).

### Health & fitness
- **Google Health API** — read AND write: meals, sleep, weight, steps, heart rate, hydration via custom `health-api.js` skill. Handles OAuth automatically through gog tokens.
- **Hevy** — workout tracking and exercise logging via MCP server (user-configured).

### MCP servers (pre-configured in models.json)
- **Notion** — pages, databases, search via Notion's official remote MCP with personal OAuth (no workspace integration needed).
- **Claude Code** — read/edit code, run shell commands, search codebases. Pre-installed CLI.
- **Extensible** — add any MCP server (Actual Budget, Hevy, filesystem, custom) via `models.json`. Supports both remote HTTP (auto-proxied via stdio bridge with OAuth refresh) and local stdio servers.

### Skills (18+ pre-installed via ClawHub)
| Skill | What it does |
|-------|-------------|
| **tavily-search** | AI-optimized web search (bundled, needs API key) |
| **ddg-web-search** | DuckDuckGo search, no API key needed (ClawHub) |
| **jina-ai-reader** | Extract clean markdown from URLs (ClawHub) |
| **summarize** | Summarize long documents, PDFs, YouTube videos (ClawHub) |
| **pdf** | Extract, merge, split, fill PDF forms (ClawHub) |
| **ai-humanizer** | Rewrite AI-generated text to sound natural (ClawHub) |
| **openclaw-memory** | Persistent memory system across sessions (ClawHub) |
| **cron** | Schedule recurring agent tasks (ClawHub) |
| **clawdbot-filesystem** | Batch file operations (ClawHub) |
| **http** | Make arbitrary HTTP requests (ClawHub) |
| **vapi** | Manage Vapi voice AI agents and outbound calls (ClawHub) |
| **weather** | Weather forecasts and conditions (ClawHub) |
| **github** | Issues, PRs, CI status, repo queries (ClawHub) |
| **skill-vetter** | Scan new skills for malicious code before installing (ClawHub) |
| **find-skills** | Search ClawHub marketplace for new capabilities (ClawHub) |
| **google-health** | Google Health API for meals, sleep, weight, steps (bundled) |
| **himalaya** | Email management via himalaya CLI (bundled) |
| **reclaim** | Reclaim.ai smart scheduling (bundled) |
| **sms-gateway** | Android SMS Gateway integration (bundled) |

## Cost breakdown

| Service | Cost | Notes |
|---------|------|-------|
| **Z.ai** (glm-5-turbo) | **Free** $10/mo credits | Primary model. [Sign up](https://z.ai). **Use 32K-64K context** (see below). |
| **Oracle Cloud** | **Free forever** | 4 ARM OCPUs, 24GB RAM, 200GB disk. [Always Free tier](https://www.oracle.com/cloud/free/) |
| **Vapi** (voice calls) | ~$10 / 3 months | Pay-per-call. $10 lasts months of light use. [vapi.ai](https://vapi.ai) |
| **Capsolver** (captchas) | ~$10 / forever | Pay-per-solve. $10 lasts effectively forever. [capsolver.com](https://capsolver.com) |
| **Tavily** (web search) | Free tier | 1,000 searches/month free. [tavily.com](https://tavily.com) |
| **SMS Gateway** | Free tier | Cloud API included. [sms-gate.app](https://sms-gate.app) |
| Telegram, GitHub, Google Workspace, Signal | Free | — |

**Total: ~$10/month** (just the model credits). Everything else is free or effectively free.

### Z.ai context window guidance

Z.ai (glm-5-turbo) advertises a 200K context window, but **quality degrades significantly past ~32K tokens.** The model loses coherence, hallucinates tool names, and forgets earlier instructions in long contexts.

**Recommended:** Set `CONTEXT_TOKENS=32000` in `.env` (or 64000 max). This caps all models and forces aggressive compaction, which actually improves Z.ai output quality. The config generator respects this env var and caps all model windows accordingly.

If you use a stronger fallback model (Claude, Gemini), you can set `contextWindow` per-model in `models.json` to give them a larger window while keeping Z.ai small.

### Adding a fallback model

Add a fallback model for when Z.ai credits run out. Recommended: [Qwen 35 Claude 4.6 Opus Reasoning](https://huggingface.co/mradermacher/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-i1-GGUF) — 27B parameters, vision support, runs on consumer hardware via llama.cpp.

## Quick start

```bash
cp models.example.json models.json    # configure model providers and fallback order
cp .env.example .env                  # add API keys, channel tokens, and tool credentials
sh scripts/rebuild.sh                 # build and run
```

API keys for model providers go in `.env` (e.g., `ANTHROPIC_API_KEY=sk-ant-...`) and are referenced via `{{VAR}}` templates in `models.json`. Channel tokens, tool credentials, and everything else also go in `.env`.

**If using Z.ai:** Add `CONTEXT_TOKENS=32000` to `.env` for best results (see [Z.ai context window guidance](#zai-context-window-guidance)).

## Deploy to Oracle Cloud (Always Free)

Build the ARM image and push to Oracle Container Registry using the OCI CLI:

```bash
# One-time setup
pip install oci-cli
oci setup config
# Generate an auth token: OCI Console → User Settings → Auth Tokens
echo "OCI_AUTH_TOKEN=your-auth-token" >> .env

# Enable ARM cross-compilation (one-time, if building on x86)
docker run --rm --privileged multiarch/qemu-user-static --reset -p yes

# Build, push, and deploy
bash scripts/deploy-oracle.sh
```

The deploy script auto-detects region, namespace, compartment, username, AD, and subnet from your OCI CLI config. The only manual value is the auth token in `.env`.

**What it does:**
1. Builds `Dockerfile.ARM` for `linux/arm64`
2. Tags and pushes to `<region>.ocir.io`
3. Creates a Container Instance (`CI.Standard.A1.Flex`, 1 OCPU, 6 GB RAM — free tier)
4. Streams container logs to your terminal

## Architecture

```
models.json          — model providers, fallback order, MCP servers (gitignored)
.env                 — channel + tool credentials (gitignored)
prompts/             — SOUL.md, AGENTS.md, SYSTEM.md, USER.md, HEARTBEAT.md
skills/              — bundled skills with SKILL.md + tools (health-api.js, etc.)
harness/             — container runtime: entrypoint, config generator, browser, relay, supervisord
scripts/             — host-side setup scripts (gog-health-auth.sh, notion-auth.js)
credentials/         — password exports, OAuth tokens, himalaya config (gitignored)
```

## Configuration

All runtime config is generated from `models.json` + `.env` by `generate-config.js` at boot. Workspace files are seeded on first boot and survive rebuilds.

---

### Communication channels

#### Telegram

```
TELEGRAM_BOT_TOKEN=your-bot-token
TELEGRAM_ALLOW_FROM=your-telegram-user-id
```
Find your user ID: message [@userinfobot](https://t.me/userinfobot). With `TELEGRAM_ALLOW_FROM` set, your chat is pre-authorized.

#### Email (himalaya)

IMAP/SMTP email. Config lives in `credentials/himalaya.toml`, mounted at `~/.config/himalaya/config.toml`.

#### SMS (Android SMS Gateway)

Read and send texts from your Android phone via [Android SMS Gateway](https://github.com/capcom6/android-sms-gateway).

```
SMS_GATEWAY_URL=https://api.sms-gate.app:443
SMS_GATEWAY_USERNAME=your-username
SMS_GATEWAY_PASSWORD=your-password
```

**Phone setup:**

1. Install from [Google Play](https://play.google.com/store/apps/details?id=me.capcom.smsgateway) or [F-Droid](https://f-droid.org/packages/me.capcom.smsgateway/)
2. Create an account, copy username and password into `.env`
3. **Samsung**: Settings → Apps → SMS Gateway → Battery → **Unrestricted**
4. **Android 13+**: if SMS permissions are blocked, [allow restricted settings](https://support.google.com/android/answer/12623953?hl=en): Settings → Apps → SMS Gateway → ⋮ → **Allow restricted settings**, then re-grant permissions

The relay service polls SMS every 2 minutes and sends a batched summary to Telegram with conversation context (5 messages before + follow-ups).

#### Voice calls (Vapi)

```
VAPI_API_KEY=your-vapi-api-key
VAPI_ASSISTANT_ID=your-assistant-id
VAPI_PHONE_NUMBER_ID=your-phone-number-id
```

#### Signal

```
SIGNAL_NUMBER=+1234567890
SIGNAL_ALLOW_FROM=+1234567890
```
One-time registration inside the container — see `signal-cli` docs.

---

### Tools

#### Google Workspace + Health API (gog CLI)

One token for both Google Workspace and Health API.

1. Create OAuth client (Desktop App) at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable the [Google Health API](https://console.cloud.google.com/apis/api/health.googleapis.com) in your project
3. Save client secret as `credentials/credentials.json`
4. Authenticate with Workspace + health scopes:
```bash
bash scripts/gog-health-auth.sh you@company.com
```
This opens a browser, requests all Workspace services plus health scopes (nutrition, sleep, activity, metrics), and saves the token.

If you don't need the Health API, use plain gog auth instead:
```bash
gog auth credentials credentials/credentials.json
gog auth add you@company.com --services user
gog auth tokens export you@company.com --out credentials/gog-token.json --overwrite
```

#### GitHub

```
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```
Create at [github.com/settings/tokens](https://github.com/settings/tokens?type=beta) — Fine-grained, with Contents/Issues/PRs read+write.

#### Reclaim.ai

```
RECLAIM_API_KEY=your-reclaim-api-key
```
Get from [app.reclaim.ai/settings/developer](https://app.reclaim.ai/settings/developer). Auto-schedules tasks and habits on Google Calendar.

#### Capsolver

```
CAPSOLVER_API_KEY=your-capsolver-api-key
```
Get from [capsolver.com](https://www.capsolver.com/). Loaded into stealth Chrome at boot — auto-solves captchas.

#### Web search

```
TAVILY_API_KEY=your-tavily-api-key
```
Get from [tavily.com](https://tavily.com/). DuckDuckGo works as fallback with no key.

---

### MCP servers

MCP servers are defined in `models.json` under `mcpServers`. Two types:

**Remote HTTP** — proxied via `mcp-http-proxy.js` (stdio bridge):
```json
"my-server": {
  "url": "https://your-server.com/sse",
  "auth": "Bearer your-token",
  "description": "What this server does"
}
```

**Local stdio** — spawned directly:
```json
"my-tool": {
  "command": "npx",
  "args": ["-y", "@some/mcp-server"],
  "env": { "API_KEY": "{{MY_ENV_VAR}}" },
  "description": "What this tool does"
}
```

Use `{{VAR_NAME}}` in env/auth values to reference environment variables or API keys from providers.

#### Recommended MCP servers

| Server | What it does | Setup |
|--------|-------------|-------|
| [Notion MCP](https://developers.notion.com/docs/mcp) | Pages, databases, search | `node scripts/notion-auth.js` for OAuth, no integration needed |
| [Claude Code](https://code.claude.com) | Read/edit code, run shell commands, search codebases | Pre-installed. Needs `ANTHROPIC_API_KEY` in a provider. |
| [Actual Budget](https://actualbudget.org) | Budgets, accounts, transactions | Self-hosted MCP, connect via URL |
| [Hevy](https://hevy.com) | Workout tracking, exercise logging | Self-hosted MCP, connect via URL |
| [Open Wearables](https://github.com/the-momentum/open-wearables) | Sleep, activity, heart rate from Samsung/Health Connect | Docker Compose sidecar with built-in MCP |
| [Filesystem](https://github.com/modelcontextprotocol/servers) | Advanced file operations | `npx -y @modelcontextprotocol/server-filesystem /data` |

#### Notion (personal OAuth, no integration needed)

Notion connects via [Notion's official remote MCP](https://developers.notion.com/docs/mcp) using personal OAuth. No workspace integration or admin approval required.

```bash
node scripts/notion-auth.js
```
Opens browser → sign in with Notion → tokens saved to `credentials/notion-oauth.json`. Auto-refreshes forever. Works with any workspace your account can access.

---

### Credentials

Put auth files and password-manager exports in `./credentials/`. Inside the container they appear at `/home/clawuser/credentials` (read-only mount). The agent looks up saved passwords from `*.csv` files automatically when browser logins are needed.
