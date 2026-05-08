# Listec worksheet report — Node.js (mssql) quickstart

Copy these files into your app (same folder or adjust imports):

| File | Purpose |
|------|---------|
| [listec.types.ts](listec.types.ts) | TypeScript shapes for filters + rows |
| [listec.client.ts](listec.client.ts) | Connection pool + `fetchWorksheetReports()` |
| [example.express.ts](example.express.ts) | Minimal REST API |
| [.env.example](.env.example) | Environment variable names |

## Step 1 — Install

```bash
npm install mssql dotenv express
npm install -D typescript @types/node @types/express
```

Target: **mssql v11.x** (matches Node 18+). Use `npm install mssql@^11`.

## Step 2 — Deploy the stored procedure

On SQL Server (database **Noble**), run:

- [`../../sp/usp_listec_worksheet_report_json.sql`](../../sp/usp_listec_worksheet_report_json.sql)

Then create a least-privilege login:

- [`../../sp/grant_listec_ro.sql`](../../sp/grant_listec_ro.sql) — replace `<STRONG_PASSWORD_HERE>`.

## Step 3 — Configure `.env`

```bash
# From the Listec app root (this folder’s parent):
cp integration/node-mssql/.env.example .env
# edit LISTEC_SQL_* and PORT
```

Use the **`listec_ro`** login in production — not `db_owner` credentials from `Web.config`.

## Step 4 — Call from code

```typescript
import 'dotenv/config';
import { fetchWorksheetReports } from './listec.client';

const rows = await fetchWorksheetReports({
  fromDate: '2026-05-08',
  toDate: '2026-05-08',
  fromHour: 0,
  toHour: 24,
  page: 1,
  pageSize: 50,
});

for (const r of rows) {
  console.log(r.sid, r.patient_name, r.results.length, 'results');
}
```

## Step 5 — Smoke-test the REST sample

```bash
npx ts-node example.express.ts
# curl "http://127.0.0.1:3100/api/worksheet-reports?fromDate=2026-05-08&toDate=2026-05-08&pageSize=5"
```

Full reference + AI-agent prompt block: [`../../docs/worksheet-report-sp.md`](../../docs/worksheet-report-sp.md).

## Read-only validation

Before you deploy, the new SP logic was compared to `usp_worksheet_sample02072020` on the live `Noble` database for the **calendar day of the test run** — row counts matched (`legacy_cnt` = `new_logic_cnt`), and a sample `FOR JSON` payload parsed successfully. Re-run that check on your environment after deploy.
