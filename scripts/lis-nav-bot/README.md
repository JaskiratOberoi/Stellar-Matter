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

## Usage

```bash
node lis-nav-bot.js --bu QUGEN --status "Partially Tested" --test-code he011 --from-date 01/05/2026 --to-date 04/05/2026
```

Optional: open one SID modal read-only and dump row labels:

```bash
node lis-nav-bot.js --bu QUGEN --status "Tested" --test-code he011 --open-sid 8402130
```

Flags can be mirrored in env (CLI wins): `LIS_BU`, `LIS_STATUS`, `LIS_TEST_CODE`, `LIS_FROM_DATE`, `LIS_TO_DATE`, `LIS_FROM_HOUR`, `LIS_TO_HOUR`, `LIS_CLIENT_CODE`, `LIS_SID`, `LIS_VAIL_ID`, `LIS_PID`, `LIS_DEPT_NO`, `LIS_OPEN_SID`, `LIS_MAX_SIDS`, `LIS_OUT_DIR`, `LIS_DRY_RUN`, `LIS_HEADLESS`, `LIS_SCREENSHOTS`.

## Outputs

- Default `--out-dir` is `./out` (under `scripts/lis-nav-bot/`).
- Writes `run-<timestamp>.json` with filters applied, SIDs seen, and optional modal dump.
- With `--screenshots` (default: on), saves PNGs under `out/screenshots/`.

## Pagination

Page 1 of `gvSample` only for this version.

## See also

[`../../internal/lis-navigation-reference.md`](../../internal/lis-navigation-reference.md)
