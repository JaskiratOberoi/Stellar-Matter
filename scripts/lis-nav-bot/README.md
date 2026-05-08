# lis-nav-bot

Read-only Puppeteer CLI for the LIS **Sample Worksheet** (`Sampleworksheet.aspx`). It logs in, applies **optional** filters from CLI or env, clicks **Search**, lists SIDs on **page 1**, and may open one SID to **read** worksheet row labels — **no Save**, no value edits, no Auth.

## Safety

- Starts with log: `READ-ONLY MODE — no LIS writes will be performed`.
- If `LIS_ALLOW_WRITES=1` is set in the environment, the process **exits** (reserved for a future write-capable tool).

## Setup

```bash
cd scripts/lis-nav-bot
npm install
copy .env.example .env
# Edit .env: LIS_TARGET_URL, LIS_LOGIN_USERNAME, LIS_LOGIN_PASSWORD
```

You can instead put shared variables in the **repository root** `.env` (two levels up). The CLI and `npm run ui` load, in order: **`scripts/lis-nav-bot/.env`**, **repository root** `.env**, then (on Windows, if that file exists) **`X:\\Listec Automation\\.env`** — the CBC Autobots / Listec store (`CBC_LOGIN_USERNAME`, `CBC_LOGIN_PASSWORD`, etc.; see [`internal/lis-navigation-reference.md`](../../internal/lis-navigation-reference.md)). The **first** file that defines a variable wins; later files only fill in keys that are still unset.

To load a different Autobots `.env`, set **`LIS_AUTOBOTS_ENV`** to its full path (OS env or any file loaded in an earlier step).

## Local web UI

- From `scripts/lis-nav-bot`, credentials stay in `.env` / repo root `.env` (same as CLI). The browser never sends passwords.
- Start the UI: `npm run ui` (runs `node server.js`).
- Opens on **http://127.0.0.1:4377/** by default. Override with **`LIS_UI_PORT`** (and optionally **`LIS_UI_HOST`**; bind to loopback only unless you know you need otherwise — do not expose this on a LAN without a reverse proxy and authentication).

## Usage

```bash
node lis-nav-bot.js --bu QUGEN --status "Partially Tested" --test-code he011 --from-date 01/05/2026 --to-date 04/05/2026
```

Optional: open one SID modal read-only and dump row labels:

```bash
node lis-nav-bot.js --bu QUGEN --status "Tested" --test-code he011 --open-sid 8402130
```

Flags can be mirrored in env (CLI wins): `LIS_BU`, `LIS_STATUS`, `LIS_TEST_CODE`, `LIS_FROM_DATE`, `LIS_TO_DATE`, `LIS_FROM_HOUR`, `LIS_TO_HOUR`, `LIS_CLIENT_CODE`, `LIS_SID`, `LIS_VAIL_ID`, `LIS_PID`, `LIS_DEPT_NO`, `LIS_OPEN_SID`, `LIS_OUT_DIR`, `LIS_DRY_RUN`, `LIS_HEADLESS`, `LIS_SCREENSHOTS`, **`LIS_SCRAPE_PACKAGES=1`**.

## Package scrape (`--scrape-packages`)

Paginates every page of the Sample Worksheet grid (`gvSample`) until no further page exists (internal safety limit 10000 pages) and extracts every `[...]` label from the Test Names cell (`span[id*='lblTestnames']`). Continuation rows without their own SID link inherit the previous row’s SID for mapping; occurrence counts include bracket text even when the SID cell is blank. Produces `out/run-<timestamp>-packages.json` with **label → list of SIDs** (when attributable), occurrence counts, and per-page row diagnostics.

```bash
node lis-nav-bot.js --bu ROHTAK --scrape-packages
```

Long runs that exceed the LIS worksheet session lifetime are **automatically recovered** (re-login → re-apply filters → Search → resume at the next grid page after the last fully scraped pager page). Up to **three** recovery attempts per run are allowed; failures are surfaced in **`run-<timestamp>-packages.json`**, **`run-<timestamp>.json`**, and in the **`npm run ui`** latest summary (“Session recoveries”). Partial **`run-<timestamp>-packages.json`** snapshots are written every **10** pages so a hard kill mid-run still leaves usable progress.

## Outputs

- Default `--out-dir` is `./out` (under `scripts/lis-nav-bot/`).
- Writes `run-<timestamp>.json` with filters applied and **all** SIDs on **page 1**.
- With **`--scrape-packages`**, also writes `run-<timestamp>-packages.json` (all pages, bracket labels ↔ SIDs).
- **Package page counts (UI):** keep **pages per printed report** (one occurrence) for each label in **`data/package-pages.json`**. The Package labels table’s **Total Pages** column is **occurrence count × that value**; edit the JSON centrally; **`GET /api/package-pages`** re-reads it on each request so a browser refresh picks up changes without restarting the server.
- With `--screenshots` (default: on), saves PNGs under `out/screenshots/`.

## Pagination

- **Normal / open-SID mode:** reads SIDs from **page 1** only.
- **`--scrape-packages`:** walks **all** grid pages returned by Search until the pager stops (plus ellipsis / `Page$N` jumps).

## Data source: web scrape vs SQL (direct)

Two execution paths produce the same `out/run-*.json` + `out/run-*-packages.json` artifacts so the dashboard works unchanged.

| Source | How it works | When to use |
|--------|--------------|-------------|
| **Web scrape** (default) | Headless Chromium logs in, applies filters, paginates `gvSample`. | LIS DB unreachable, or you need the open-SID modal/screenshots. |
| **SQL (direct)** | Calls the Listec mssql HTTP service ([`Listec/integration/node-mssql/`](../../Listec/integration/node-mssql/)) which executes `dbo.usp_listec_worksheet_report_json` against `Noble`. One round-trip, no browser. | Default for production reporting — orders of magnitude faster, no session recovery, returns full results in one call. |

Switch via:

- UI: **Data source** radio at the top of the Run sidebar (persisted in `localStorage` under `lisbot:source`).
- CLI: `--source sql` or env `LIS_SOURCE=sql`.

SQL source env:

```bash
LISTEC_API_BASE_URL=http://127.0.0.1:3100   # default
```

To bring up the Listec service:

```bash
cd Listec/integration/node-mssql
npm install
npm run deploy:sp ../../sp/usp_listec_worksheet_report_json.sql   # one-time
npm run dev                                                       # service on :3100
```

Note: the SP requires SQL Server **2016+** (uses `FOR JSON PATH`). The grant of a dedicated `listec_ro` login is deferred — the service today uses the credentials in `Listec/.env` (gitignored). Rotate / least-privilege per the bundle's [`docs/worksheet-report-sp.md`](../../Listec/docs/worksheet-report-sp.md).

## See also

[`../../internal/lis-navigation-reference.md`](../../internal/lis-navigation-reference.md)
