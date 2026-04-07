const fs = require("node:fs");
const path = require("node:path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
const { generateCapsolverConfig } = require("./capsolver-config");

puppeteer.use(StealthPlugin());

// ── Helpers ──────────────────────────────────────────────────────────────────

function env(name, fallback) {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed || fallback;
}

function envBoolean(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== "string") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function resolveExecutablePath() {
  const explicit = env("STEALTH_BROWSER_EXECUTABLE_PATH", "");
  if (explicit && fs.existsSync(explicit)) return explicit;

  const playwrightRoot = "/ms-playwright";
  if (!fs.existsSync(playwrightRoot)) return undefined;

  for (const entry of fs.readdirSync(playwrightRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("chromium-")) continue;
    const candidate = path.join(playwrightRoot, entry.name, "chrome-linux64", "chrome");
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

// ── Capsolver extension setup ────────────────────────────────────────────────
// Patches the extension's config.js with our API key and enables all captcha
// types. Returns the extension path for --load-extension, or null if not available.

function setupCapsolverExtension() {
  const apiKey = env("CAPSOLVER_API_KEY", "");
  if (!apiKey) {
    console.warn("[stealth-browser] CAPSOLVER_API_KEY not set — captcha solving disabled");
    return null;
  }

  const srcDir = "/opt/capsolver-extension";
  if (!fs.existsSync(path.join(srcDir, "manifest.json"))) {
    console.warn("[stealth-browser] Capsolver extension not found at " + srcDir);
    return null;
  }

  // Copy extension to a writable location (srcDir may be root-owned)
  const workDir = "/tmp/capsolver-extension";
  try {
    fs.cpSync(srcDir, workDir, { recursive: true, force: true });
  } catch (e) {
    console.warn("[stealth-browser] Failed to copy capsolver extension:", e.message);
    return null;
  }

  const assetsDir = path.join(workDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  const configPath = path.join(assetsDir, "config.js");

  try {
    fs.writeFileSync(configPath, generateCapsolverConfig(apiKey), "utf8");
    console.log("[stealth-browser] Capsolver extension configured at " + workDir);
    return workDir;
  } catch (e) {
    console.warn("[stealth-browser] Failed to write capsolver config:", e.message);
    return null;
  }
}

// ── Page hardening ───────────────────────────────────────────────────────────

async function hardenPage(page) {
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
    Object.defineProperty(navigator, "language", { get: () => "en-US" });
    Object.defineProperty(navigator, "platform", { get: () => "Win32" });
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
    Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });

    const pluginData = [
      { name: "Chrome PDF Plugin", filename: "internal-pdf-viewer", description: "Portable Document Format" },
      { name: "Chrome PDF Viewer", filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai", description: "" },
      { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "" },
    ];
    const pluginArray = pluginData.map((p) => {
      const plugin = Object.create(Plugin.prototype);
      Object.defineProperties(plugin, {
        name: { get: () => p.name },
        filename: { get: () => p.filename },
        description: { get: () => p.description },
        length: { get: () => 1 },
      });
      return plugin;
    });
    Object.defineProperty(pluginArray, "length", { get: () => pluginData.length });
    Object.defineProperty(navigator, "plugins", { get: () => pluginArray });

    globalThis.chrome = globalThis.chrome || {};
    globalThis.chrome.runtime = globalThis.chrome.runtime || {
      OnInstalledReason: { CHROME_UPDATE: "chrome_update", INSTALL: "install", SHARED_MODULE_UPDATE: "shared_module_update", UPDATE: "update" },
      OnRestartRequiredReason: { APP_UPDATE: "app_update", OS_UPDATE: "os_update", PERIODIC: "periodic" },
      PlatformArch: { ARM: "arm", ARM64: "arm64", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformNaclArch: { ARM: "arm", MIPS: "mips", MIPS64: "mips64", X86_32: "x86-32", X86_64: "x86-64" },
      PlatformOs: { ANDROID: "android", CROS: "cros", LINUX: "linux", MAC: "mac", OPENBSD: "openbsd", WIN: "win" },
      RequestUpdateCheckStatus: { NO_UPDATE: "no_update", THROTTLED: "throttled", UPDATE_AVAILABLE: "update_available" },
    };
    if (!globalThis.chrome.app) {
      globalThis.chrome.app = { isInstalled: false, InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" }, RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" } };
    }
    if (!globalThis.chrome.csi) globalThis.chrome.csi = () => ({});
    if (!globalThis.chrome.loadTimes) globalThis.chrome.loadTimes = () => ({});

    if (globalThis.Permissions && globalThis.Permissions.prototype.query) {
      const origQuery = globalThis.Permissions.prototype.query;
      globalThis.Permissions.prototype.query = function query(params) {
        if (params?.name === "notifications") return Promise.resolve({ state: Notification.permission });
        return origQuery.call(this, params);
      };
    }

    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Google Inc. (NVIDIA)";
      if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
      return getParameter.call(this, param);
    };
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (param) {
      if (param === 37445) return "Google Inc. (NVIDIA)";
      if (param === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
      return getParameter2.call(this, param);
    };

    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    const canvasNoiseSeed = Math.floor(Math.random() * 255) + 1;
    HTMLCanvasElement.prototype.toDataURL = function (type) {
      const ctx = this.getContext("2d");
      if (ctx) {
        const imageData = ctx.getImageData(0, 0, Math.min(this.width, 2), Math.min(this.height, 2));
        imageData.data[0] = (imageData.data[0] + canvasNoiseSeed) & 0xff;
        ctx.putImageData(imageData, 0, 0);
      }
      return origToDataURL.call(this, type);
    };

    if (navigator.connection === undefined) {
      Object.defineProperty(navigator, "connection", {
        get: () => ({ effectiveType: "4g", rtt: 50, downlink: 10, saveData: false }),
      });
    }

    const origContentWindowDesc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
    if (origContentWindowDesc?.get) {
      const origContentWindowGet = origContentWindowDesc.get;
      Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
        get() {
          const win = origContentWindowGet.call(this) || globalThis;
          return new Proxy(win, {
            get: (target, prop) => {
              if (prop === "chrome") return globalThis.chrome;
              return Reflect.get(target, prop);
            },
          });
        },
      });
    }

    Object.defineProperty(screen, "width", { get: () => 1920 });
    Object.defineProperty(screen, "height", { get: () => 1080 });
    Object.defineProperty(screen, "availWidth", { get: () => 1920 });
    Object.defineProperty(screen, "availHeight", { get: () => 1040 });
    Object.defineProperty(screen, "colorDepth", { get: () => 24 });
    Object.defineProperty(screen, "pixelDepth", { get: () => 24 });
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const executablePath = resolveExecutablePath();
  if (!executablePath) throw new Error("No Chromium executable found for stealth browser");

  console.log("[stealth-browser] Chromium path: " + executablePath);
  console.log("[stealth-browser] DISPLAY: " + (process.env.DISPLAY || "(unset)"));

  const remoteDebugPort = Number.parseInt(env("STEALTH_BROWSER_PORT", "9223"), 10);
  const remoteDebugHost = env("STEALTH_BROWSER_HOST", "127.0.0.1");

  // Use a temp dir for user data — avoids stale lock files from the persistent
  // Docker volume that cause "profile in use by another process" crashes.
  // Browser state (cookies, sessions) does not need to persist across restarts.
  const userDataDir = fs.mkdtempSync("/tmp/stealth-browser-");
  console.log("[stealth-browser] User data dir: " + userDataDir);

  // Capsolver extension — must be loaded at launch time
  const capsolverPath = setupCapsolverExtension();

  // Always use headless=new in Docker. Chrome's new headless mode supports
  // extensions since Chrome 112+. Non-headless mode with Xvfb is fragile
  // in containers and causes crashes with security restrictions (cap_drop).
  const headless = "new";
  console.log("[stealth-browser] headless=new (extensions supported in new headless mode)");

  const userAgent = env(
    "STEALTH_BROWSER_USER_AGENT",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
  );
  const windowSize = env("STEALTH_BROWSER_WINDOW_SIZE", "1920,1080");

  // Build Chrome args
  const args = [
    `--remote-debugging-port=${remoteDebugPort}`,
    `--remote-debugging-address=${remoteDebugHost}`,
    `--user-agent=${userAgent}`,
    `--window-size=${windowSize}`,
    "--disable-blink-features=AutomationControlled",
    "--disable-dev-shm-usage",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-infobars",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--lang=en-US,en",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--use-mock-keychain",
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-gpu",
    "--disable-popup-blocking",
    "--disable-component-update",
    "--disable-default-apps",
    "--metrics-recording-only",
  ];

  // Load capsolver extension if available
  if (capsolverPath) {
    args.push(
      `--disable-extensions-except=${capsolverPath}`,
      `--load-extension=${capsolverPath}`,
    );
  }

  const browser = await puppeteer.launch({
    executablePath, headless, userDataDir,
    ignoreDefaultArgs: ["--enable-automation"],
    args,
    defaultViewport: null,
  });

  const existingPages = await browser.pages();
  await Promise.all(existingPages.map(hardenPage));

  browser.on("targetcreated", async (target) => {
    if (target.type() !== "page") return;
    try {
      const page = await target.page();
      if (page) await hardenPage(page);
    } catch (error) {
      console.warn("[stealth-browser] failed to harden page:", error);
    }
  });

  const wsEndpoint = browser.wsEndpoint();
  console.log(`[stealth-browser] ready on http://${remoteDebugHost}:${remoteDebugPort}`);
  console.log(`[stealth-browser] ws endpoint: ${wsEndpoint}`);
  console.log(`[stealth-browser] capsolver: ${capsolverPath ? "active (auto-solve)" : "disabled"}`);

  const shutdown = async (signal) => {
    console.log(`[stealth-browser] shutting down on ${signal}`);
    await browser.close().catch(() => {});
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

(async () => {
  try { await main(); }
  catch (error) { console.error("[stealth-browser] fatal:", error); process.exit(1); }
})();
