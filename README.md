# Stellar Matter

LIS reporting dashboard for the editorial tile workflow — Letter Heads & Envelopes.
Backend in Docker on a self-hosted server, frontend deployed to Hostinger at
[matter.stellarinfomatica.com](https://matter.stellarinfomatica.com).

> The legacy `scripts/lis-nav-bot/` Puppeteer + vanilla-UI tool still ships
> inside the same repo (and inside the Docker image) — see
> [`scripts/lis-nav-bot/README.md`](scripts/lis-nav-bot/README.md) for CLI flags
> and SQL-vs-scrape modes. This README covers the production app on top of it.

## Repo layout

```
web/                       React + Vite SPA (deployed to Hostinger)
server/                    Express auth/admin layer (loads the legacy server)
scripts/lis-nav-bot/       Original CLI + scrape engine + run artefacts (out/)
scripts/hostinger-dns.js   One-off: upsert matter / api-matter DNS records
Dockerfile                 Multi-stage: Vite build + Node 20 + Chromium
docker-compose.yml         Postgres 16 + app, ports 4378 / 5434
.env.example               Every env var the stack reads
```

`web/` and `server/` are **npm workspaces** — `npm install` at the repo root
installs both. `npm run dev` boots the legacy Node UI server (port 4377) and the
Vite dev server (port 5173) in parallel via `concurrently`.

## Letter Heads vs Envelopes

The dashboard now has two equivalent tile walls:

- **Letter Heads** — counts **printed pages per package** (occurrence × pages
  from `data/package-pages.json`). Each tile metric is a page total; the modal
  shows a per-package Pages column.
- **Envelopes** — same packages, re-aggregated by envelope size:
  - `> 10` printed pages → **big envelope** (+1)
  - `≤ 10` printed pages → **small envelope** (+1)
  - Unknown page count → estimated as a small envelope and flagged in the modal.

Both tabs share the same tiles, modal, sidebar, run progress strip, and
multi-BU fan-out. Switching tabs only changes the metric displayed.

## Local development

```bash
# Repo root
npm install                  # installs web/ + server/ workspaces
cp .env.example .env         # edit JWT_SECRET, SUPER_ADMIN_*, etc.
npm run dev                  # boots Vite on :5173 + Express on :4377
```

Vite proxies `/api/*` to the Express server, so the SPA hits real endpoints with
zero CORS in dev. Auth is **disabled** if `DATABASE_URL` is unset — the legacy
flow keeps working unchanged.

To exercise auth + admin locally, point `DATABASE_URL` at a Postgres (the
docker-compose service or a local install), run `npm run migrate` once to
create the `users` table and seed the super_admin from `SUPER_ADMIN_USERNAME` /
`SUPER_ADMIN_PASSWORD`, then log in at `/login`.

## Docker (production backend on a self-hosted box)

```bash
cp .env.example .env         # MUST set JWT_SECRET + SUPER_ADMIN_PASSWORD
docker compose up -d --build
docker compose logs -f app   # tail to confirm migrate() ran + super_admin seeded
```

Defaults:

| Service  | Host port | In-container | Notes |
|----------|-----------|--------------|-------|
| `app`    | `4378`    | `4377`       | Express + Chromium (Puppeteer) |
| `db`     | `5434`    | `5432`       | Postgres 16, named volume `pgdata` |

The compose file mounts `./out` (run artefacts) and `./scripts/lis-nav-bot/data/package-pages.json` (read-only) so a container restart never loses history.

The first super_admin is seeded from `SUPER_ADMIN_USERNAME` / `SUPER_ADMIN_PASSWORD`
on every container start (idempotent — only inserts if absent). Rotate the env
var, restart, and reseed if you ever lock yourself out.

## Caddy reverse proxy

Add the `api-matter.stellarinfomatica.com` block (already appended to
`Z:/Ares-CRM/server/Caddyfile`, mirroring the Nexus block) and reload:

```bash
# On the host running Caddy:
caddy reload --config Z:/Ares-CRM/server/Caddyfile
```

This terminates TLS, sets CORS, and forwards to `localhost:4378` (the Docker
app). The frontend at `https://matter.stellarinfomatica.com` calls
`https://api-matter.stellarinfomatica.com/api/*` — no other origins are allowed.

## Hostinger DNS bootstrap (one-time)

`matter.stellarinfomatica.com` (frontend) and `api-matter.stellarinfomatica.com`
(reverse-proxied to your home server) are managed via the Hostinger Developer
API. Paste `HOSTINGER_API_KEY` into `.env`, then:

```bash
# Frontend subdomain — points at Hostinger's web hosting IP.
node scripts/hostinger-dns.js \
  --domain stellarinfomatica.com \
  --record matter \
  --type A \
  --value <HOSTINGER_WEB_IP>

# API subdomain — points at your home server's public IP.
node scripts/hostinger-dns.js \
  --domain stellarinfomatica.com \
  --record api-matter \
  --type A \
  --value <HOME_SERVER_PUBLIC_IP>
```

The script is idempotent (no-ops when the existing record already matches) and
supports `--dry-run`. Comma-separate `--record` to upsert several at once.

## Frontend deploy (Hostinger via GitHub Actions)

Push to `main` with changes under `web/**` and the workflow at
`.github/workflows/deploy-stellar-matter-frontend.yml` builds and rsyncs
`web/dist/` to Hostinger over SSH. Required repo secrets (mirrors Nexus):

- `HOSTINGER_SSH_HOST`
- `HOSTINGER_SSH_PORT`
- `HOSTINGER_SSH_USERNAME`
- `HOSTINGER_SSH_PRIVATE_KEY`
- `HOSTINGER_SSH_KNOWN_HOSTS`
- `HOSTINGER_MATTER_SSH_PATH` (falls back to `HOSTINGER_SSH_PATH`)

The build bakes `VITE_API_BASE_URL=https://api-matter.stellarinfomatica.com`
from `web/.env.production`; override with the `VITE_API_BASE_URL` repo variable
if you point `matter.` at a staging API.

## End-to-end smoke test

1. `docker compose up -d --build` and confirm `app` health is `healthy`.
2. Visit `http://localhost:4378/`, log in as the seeded super_admin.
3. Open **Admin → Users**, create an `operator` account.
4. Pick 2+ BU chips, switch source to **SQL**, hit **Run** — confirm the fan-out
   strip increments per BU and a tile lands for each completed run.
5. Switch to the **Envelopes** tab — same tiles, metric flips to envelope
   counts; click a tile and confirm the modal column header reads "Envelope".
6. Push frontend changes to `main`, wait for the GitHub Action, then `curl -I
   https://matter.stellarinfomatica.com/` — expect `200`.
