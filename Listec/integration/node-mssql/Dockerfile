# --- Build stage: compile TypeScript ----------------------------------------
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY *.ts ./
RUN npm run build

# --- Runtime: compiled JS only ----------------------------------------------
FROM node:20-bookworm-slim
WORKDIR /app

ENV NODE_ENV=production \
    LISTEC_API_HOST=0.0.0.0 \
    LISTEC_API_PORT=3100 \
    LISTEC_ALIAS_NO_WATCH=1

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY --from=build /app/dist ./dist
# regionAliases.ts resolves `__dirname/data/region-aliases.json`, and
# `__dirname` after compile is /app/dist — so the data folder must live at
# /app/dist/data. Bind-mount this path in compose to hot-edit aliases.
COPY data ./dist/data

EXPOSE 3100
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3100/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/example.express.js"]
