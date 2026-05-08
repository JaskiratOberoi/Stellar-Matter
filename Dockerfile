# --- Build SPA (Vite is a devDependency) ----------------------------------
FROM node:20-bookworm-slim AS web-build
WORKDIR /app/web

COPY web/package.json web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

# --- Runtime: Express + Puppeteer (system Chromium) -----------------------
FROM node:20-bookworm-slim

# System Chromium for the legacy LIS scrape path. The SQL source path doesn't
# need it, but we keep it baked in so the same image handles both data sources.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        wget \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
# Legacy lib/run.js reads LIS_CHROMIUM_EXECUTABLE_PATH first, then falls
# back to bundled Chromium. Point it at the Debian package.
ENV LIS_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production
ENV MATTER_APP_PORT=4378
ENV LIS_UI_PORT=4378
ENV LIS_UI_HOST=0.0.0.0

WORKDIR /app

# Top-level workspace manifest + lockfiles. We install web + server deps in
# one shot via npm workspaces; Puppeteer's downloader is skipped via env above.
COPY package.json package-lock.json* ./
COPY server/package.json ./server/package.json
COPY web/package.json ./web/package.json
# Phase 11 (cli-rename): the CLI moved from scripts/lis-nav-bot/ to top-level
# cli/ and is now a real workspace. Copy its manifest so npm ci installs its
# deps (puppeteer, commander, dotenv) into the workspace-hoisted node_modules.
COPY cli/package.json ./cli/package.json

# Also install the legacy CLI's deps so scripts/lis-nav-bot/server.js can
# require puppeteer + express + dotenv when launched as the entrypoint. The
# scripts/lis-nav-bot/package.json is kept as the server's package boundary
# until server.js itself is moved.
COPY scripts/lis-nav-bot/package.json ./scripts/lis-nav-bot/package.json

RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi \
    && cd scripts/lis-nav-bot \
    && (if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi)

# Bring in the rest of the app source (server, routes, CLI, data, and the
# prebuilt SPA from the web-build stage).
COPY server ./server
COPY scripts ./scripts
COPY cli ./cli
# data/package-pages.json is the source of truth for the pages-per-package
# mapping. Bind-mounted in docker-compose so edits don't require rebuild.
COPY scripts/lis-nav-bot/data ./scripts/lis-nav-bot/data
COPY --from=web-build /app/web/dist ./web/dist

# Static assets are served by the legacy server.js for the moment (the
# express.static(publicDir) line). Once Phase 2 fully decommissions
# scripts/lis-nav-bot/public/ this can flip to web/dist exclusively.

EXPOSE 4378

CMD ["node", "server/index.js"]
