FROM mcr.microsoft.com/playwright:v1.58.2

# No build ARGs needed for API keys — config is generated at runtime
# by entrypoint.sh using env vars from docker-compose.

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth dbus-x11 fonts-noto-color-emoji fonts-liberation unzip \
    openjdk-17-jre-headless wget supervisor \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

# Install cloudflared (Cloudflare Tunnel — exposes webhook port without a public IP)
RUN curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

# Install signal-cli (requires Java 17+)
RUN wget -q https://github.com/AsamK/signal-cli/releases/download/v0.14.1/signal-cli-0.14.1.tar.gz && \
    tar xf signal-cli-0.14.1.tar.gz -C /opt && \
    ln -s /opt/signal-cli-0.14.1/bin/signal-cli /usr/local/bin/signal-cli && \
    rm signal-cli-0.14.1.tar.gz

ENV NODE_PATH=/usr/lib/node_modules:/usr/local/lib/node_modules \
    OPENCLAW_CONFIG_PATH=/home/clawuser/config/openclaw.json \
    DISPLAY=:99

# GOG_KEYRING_PASSWORD should be set via docker-compose env_file or environment,
# not baked into the image. Add it to your .env file instead.

# Install gog CLI (Google Workspace)
RUN curl -sLO https://github.com/steipete/gogcli/releases/download/v0.12.0/gogcli_0.12.0_linux_amd64.tar.gz && \
    tar -xzf gogcli_0.12.0_linux_amd64.tar.gz gog && \
    mv gog /usr/local/bin/gog && \
    rm gogcli_0.12.0_linux_amd64.tar.gz

# Install himalaya CLI (email via IMAP/SMTP)
RUN curl -sL https://github.com/pimalaya/himalaya/releases/download/v1.2.0/himalaya.x86_64-linux.tgz | tar xz -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/himalaya

# Install GitHub CLI (gh)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list && \
    apt-get update && apt-get install -y --no-install-recommends gh && \
    rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash clawuser
WORKDIR /home/clawuser/openclaw

COPY harness/ /home/clawuser/openclaw/harness/
COPY prompts/ /home/clawuser/openclaw/prompts/
COPY skills/ /home/clawuser/openclaw/skills/
COPY models.json /home/clawuser/openclaw/models.json

# Install Claude Code CLI (used as MCP server for coding tasks)
RUN npm install -g @anthropic-ai/claude-code

# Install OpenClaw + clawhub CLI + stealth browser dependencies + captcha solving
RUN npm install -g openclaw@latest clawhub@latest \
    puppeteer-extra puppeteer-core \
    puppeteer-extra-plugin-stealth puppeteer-extra-plugin-user-preferences \
    puppeteer-extra-plugin-user-data-dir puppeteer-extra-plugin-capsolver

# Extract the Capsolver Chrome extension from the npm package (it bundles it as a ZIP).
# At runtime, stealth-browser.js patches config.js with the API key and loads it into Chrome.
RUN mkdir -p /opt/capsolver-extension && \
    CAPSOLVER_ZIP=$(find /usr/lib/node_modules/puppeteer-extra-plugin-capsolver /usr/local/lib/node_modules/puppeteer-extra-plugin-capsolver -name "*.zip" 2>/dev/null | head -1) && \
    if [ -n "$CAPSOLVER_ZIP" ]; then \
      unzip -q "$CAPSOLVER_ZIP" -d /opt/capsolver-extension && \
      echo "Capsolver extension extracted from $CAPSOLVER_ZIP"; \
    else \
      echo "WARNING: Capsolver extension ZIP not found in npm package"; \
    fi && \
    chmod -R a+rw /opt/capsolver-extension

# Install skills via clawhub into a staging directory (/opt/openclaw-skills/).
# At runtime the entrypoint copies them into the persistent volume at
# ~/.openclaw/skills/ so they survive volume mounts and container restarts.
# Mapping from old @openclaw/ npm skills to clawhub registry slugs:
#   VapiAI/skills      -> vapi (owner: colygon)
#   @openclaw/fs        -> clawdbot-filesystem (owner: gtrusler)
#   @openclaw/cron      -> cron (owner: ProjectSnowWork)
#   @openclaw/jina      -> jina-ai-reader (owner: jiangtianjiao)
#   @openclaw/http      -> http (owner: ivangdavila)
#   @openclaw/memory    -> openclaw-memory (owner: AtlasPA)
#   @openclaw/search    -> ddg-web-search (owner: JakeLin, no API key needed)
#   humanizer           -> ai-humanizer (owner: brandonwise)
RUN mkdir -p /opt/openclaw-skills && \
    cd /opt/openclaw-skills && \
    # ── Core skills ──
    clawhub install vapi --no-input --force && \
    clawhub install ai-humanizer --no-input --force && \
    clawhub install clawdbot-filesystem --no-input --force && \
    clawhub install cron --no-input --force && \
    clawhub install jina-ai-reader --no-input --force && \
    clawhub install http --no-input --force && \
    clawhub install openclaw-memory --no-input --force && \
    clawhub install ddg-web-search --no-input --force && \
    # ── Additional recommended skills ──
    clawhub install summarize --no-input --force && \
    clawhub install pdf --no-input --force && \
    clawhub install weather --no-input --force && \
    clawhub install github --no-input --force && \
    clawhub install skill-vetter --no-input --force && \
    clawhub install find-skills --no-input --force && \
    echo "=== Skill directories in /opt/openclaw-skills ===" && \
    find /opt/openclaw-skills -maxdepth 3 -type d && \
    echo "=== SKILL.md files (required for discovery) ===" && \
    find /opt/openclaw-skills -name "SKILL.md" -type f && \
    echo "=== Skills in /root/.openclaw ===" && \
    find /root/.openclaw -maxdepth 3 -type d 2>/dev/null || true

RUN mkdir -p /home/clawuser/.openclaw \
             /home/clawuser/workspace \
             /home/clawuser/.config/himalaya \
             /home/clawuser/config && \
    chown -R clawuser:clawuser /home/clawuser

RUN CHROME=$(find /ms-playwright -name chrome -path "*/chrome-linux64/*" 2>/dev/null | head -1) && \
    if [ -n "$CHROME" ]; then \
      ln -sf "$CHROME" /usr/bin/google-chrome && \
      ln -sf "$CHROME" /usr/bin/chromium && \
      ln -sf "$CHROME" /usr/bin/chromium-browser; \
    fi

USER clawuser

RUN npx playwright install chromium

EXPOSE 18789

CMD ["bash", "-l", "/home/clawuser/openclaw/harness/entrypoint.sh"]
