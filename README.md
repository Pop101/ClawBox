# ClawBox - Fully Containerized Instant Image

A fully self-contained OpenClaw deployment that acts as a personal AI assistant with real-world agency. Talk to it on Telegram — it handles email, SMS, phone calls, web browsing, scheduling, coding, and more.

## What's inside

- **Multi-model failover** — models defined in `models.json` with automatic fallback chain. Swap providers by editing one file.
- **Stealth browser + Capsolver** — headless Chromium with anti-fingerprinting patches and automatic captcha solving (reCAPTCHA, hCaptcha, Turnstile, DataDome, AWS WAF).
- **Email + SMS + calls** — himalaya (IMAP/SMTP), Gmail (gog), Android SMS Gateway, Vapi voice calls. All pre-authenticated at boot.
- **SMS/email relay** — background service polls for new messages every 2 minutes and forwards summaries to Telegram with conversation context.
- **MCP servers** — connect any MCP tool (Notion, Hevy, Actual Budget, Claude Code, custom servers) via `models.json`.
- **Smart scheduling** — Google Calendar, Google Tasks, Reclaim.ai.
- **18+ skills** — web search, PDF, summarization, weather, GitHub, memory, cron, filesystem, and more.
- **Process management** — supervisord manages gateway, stealth browser, and relay with auto-restart.
- **Cost controls** — prompt caching, context pruning, quiet hours, heartbeat on cheapest model.

## Cost breakdown

| Service | Cost | Notes |
|---------|------|-------|
| **Z.ai** (glm-5-turbo) | **Free** $10/mo credits | Primary model. Fast, 200K context. [Sign up](https://z.ai) |
| **Oracle Cloud** | **Free forever** | 4 ARM OCPUs, 24GB RAM, 200GB disk. [Always Free tier](https://www.oracle.com/cloud/free/) |
| **Vapi** (voice calls) | ~$10 / 3 months | Pay-per-call. $10 lasts months of light use. [vapi.ai](https://vapi.ai) |
| **Capsolver** (captchas) | ~$10 / forever | Pay-per-solve. $10 lasts effectively forever. [capsolver.com](https://capsolver.com) |
| **Tavily** (web search) | Free tier | 1,000 searches/month free. [tavily.com](https://tavily.com) |
| **SMS Gateway** | Free tier | Cloud API included. [sms-gate.app](https://sms-gate.app) |
| Telegram, GitHub, Google Workspace, Signal | Free | — |

**Total: ~$10/month** (just the model credits). Everything else is free or effectively free.

Add a fallback model for when Z.ai credits run out. Recommended: [Qwen 35 Claude 4.6 Opus Reasoning](https://huggingface.co/mradermacher/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-i1-GGUF) — 27B parameters, vision support, runs on consumer hardware via llama.cpp.

## Quick start

```bash
cp models.example.json models.json    # add your API keys and model config
cp .env.example .env                  # fill in channel/tool credentials
sh scripts/rebuild.sh                 # build and run
```

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
