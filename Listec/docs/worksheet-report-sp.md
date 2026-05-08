# Worksheet report API — stored procedure + Node.js integration

> **Purpose**: pull **Sample Worksheet**–style data *with full test results* from the `Noble` database for a **separate application** (no Web Forms UI). One row per sample (SID / `vailid`), with a **JSON array** of every result row for that sample.

Companion docs:

- Legacy grid-only SP: `usp_worksheet_sample02072020` — background doc is **`docs/worksheet-data-fetch.md`** in the **Listec Genomics** repo (not copied into this bundle).
- DDL + grants: [`../sp/usp_listec_worksheet_report_json.sql`](../sp/usp_listec_worksheet_report_json.sql), [`../sp/grant_listec_ro.sql`](../sp/grant_listec_ro.sql)
- Drop-in Node module: [`../integration/node-mssql/`](../integration/node-mssql/)

---

## 1. Stored procedure

**Name**: `Noble.dbo.usp_listec_worksheet_report_json`  
**Deploy**: run the script [`../sp/usp_listec_worksheet_report_json.sql`](../sp/usp_listec_worksheet_report_json.sql) on SQL Server **2019+** (uses `CREATE OR ALTER`, `OFFSET/FETCH`, `FOR JSON PATH`).  
**Safety**: read-only (`SELECT` / `SET` only inside the batch).

### 1.1 Filter map (Sample Worksheet UI → parameters)

| UI control | Parameter | SQL type | NULL / omitted means |
|------------|-----------|----------|----------------------|
| From date | `@from_date` | `DATE` | **required** |
| To date | `@to_date` | `DATE` | **required** |
| From hour (0..23) | `@from_hour` | `TINYINT` | default `0` |
| To hour (1..23 or **24** = end of day) | `@to_hour` | `TINYINT` | default `24` |
| Patient name search | `@patient_name` | `NVARCHAR(200)` | no filter |
| Status | `@status_id` | `INT` | no filter |
| Client code | `@client_code` | `NVARCHAR(50)` | no filter (partial `LIKE`) |
| Val Id (SID) | `@sid` | `NVARCHAR(50)` | no filter (`vailid` or `bill_number`) |
| Dept. No | `@department_id` | `INT` | no filter |
| Business Unit | `@business_unit_id` | `INT` | no filter (`S.business_unit_id`) |
| TAT checkbox | `@tat_only` | `BIT` | **reserved** — matches legacy SP (currently unused) |
| *(extra)* Test code | `@test_code` | `NVARCHAR(50)` | no filter |
| *(extra)* PID | `@pid` | `INT` | no filter |
| Include un-authorised results | `@include_unauthorized` | `BIT` | default `1`; set `0` for only `auth = 1` rows |
| Page | `@page` | `INT` | default `1` (1-based) |
| Page size | `@page_size` | `INT` | default `500`, server clamps **1..5000** |

**Sentinel rule**: optional filters use **SQL `NULL`** (not the legacy `'0'` / `0` sentinels). In Node, pass `null` or omit; the client maps to `NULL`.

**Date window**: matches the LIS behaviour — filter on `tbl_med_mcc_patient_samples.modifieddate` between the computed `@from` / `@to` datetimes (registration time at the lab), and `sample_status > 1` (excludes “Sample Sent”).

### 1.2 Result set columns

Each row:

| Column | Type | Notes |
|--------|------|--------|
| `client_code` | string | `MCCUnitCode` — **plain text**, no HTML |
| `business_unit` | string? | from `tbl_med_business_unit_master` |
| `pid` | int | patient / registration id |
| `patient_name`, `sex`, `age`, `age_unit` | | demographics |
| `sid` | string | `vailid` |
| `sample_drawn` | datetime? | `P.sample_time` |
| `regd_at` | datetime? | `S.modifieddate` |
| `last_modified_at` | datetime? | `S.lastmodified_date` |
| `status_code` | int? | numeric status id |
| `status` | string? | label from status master |
| `test_names_csv` | string? | denormalised list from sample row |
| `order_number`, `bill_number` | string? | |
| `sample_comments`, `clinical_history` | string? | |
| `tat` | datetime? | `MAX(updateddate)` on `tbl_med_mcc_patient_test_result` for this `vailid` |
| **`results_json`** | **nvarchar(max)** | **JSON array** of test results (see below) |

After deploy, your client should **`JSON.parse(results_json)`** into `TestResult[]` (see [`../integration/node-mssql/listec.types.ts`](../integration/node-mssql/listec.types.ts)).

### 1.3 `results_json` element shape

Each object in the array:

```json
{
  "result_id": 12345,
  "test_code": "BI079",
  "test_name": "Cholesterol Total",
  "test_type": "Test",
  "value": "180",
  "unit": "mg/dL",
  "normal_range": "…",
  "abnormal": false,
  "authorized": true,
  "comments": null,
  "updated_at": "2026-05-08T08:19:00.000Z",
  "department_code": "BI",
  "department_name": "CLINICAL BIOCHEMISTRY"
}
```

Ordering inside the array: `Head` → `Profile` → `Test` → other, then `result_id`.

---

## 2. Example — SSMS

```sql
USE Noble;

EXEC dbo.usp_listec_worksheet_report_json
    @from_date              = '2026-05-08',
    @to_date                = '2026-05-08',
    @from_hour              = 0,
    @to_hour                = 24,
    @patient_name           = NULL,
    @status_id              = NULL,
    @client_code            = NULL,
    @sid                    = NULL,
    @department_id          = NULL,
    @business_unit_id       = NULL,
    @test_code              = NULL,
    @pid                    = NULL,
    @tat_only               = 0,
    @include_unauthorized   = 1,
    @page                   = 1,
    @page_size              = 50;
```

---

## 3. Least-privilege database user

Do **not** ship production reports with `nobleone` / `db_owner` from `Web.config`.

1. Edit [`../sp/grant_listec_ro.sql`](../sp/grant_listec_ro.sql) — set a strong password.
2. Run on the instance. The login **`listec_ro`** only needs **`EXECUTE`** on `dbo.usp_listec_worksheet_report_json` (the procedure runs as **dbo** inside SQL Server).

Optional: uncomment `db_datareader` in that script only if the same login runs ad-hoc `SELECT`s on tables.

---

## 4. Node.js / TypeScript integration

Follow [`../integration/node-mssql/README.md`](../integration/node-mssql/README.md):

- **Connection**: env vars `LISTEC_SQL_SERVER`, `LISTEC_SQL_DATABASE`, `LISTEC_SQL_USER`, `LISTEC_SQL_PASSWORD`
- **API**: `fetchWorksheetReports(filters)` in [`listec.client.ts`](../integration/node-mssql/listec.client.ts)
- **REST sample**: [`example.express.ts`](../integration/node-mssql/example.express.ts) — `GET /api/worksheet-reports?fromDate=…&toDate=…`

`mssql` request uses **parameterised** `request.input()` for every SP argument (no string concatenation).

---

## 5. Performance & operations

- **Keep date windows short** (single day or a few days) for interactive use; wide windows inflate `results_json` size.
- **Pagination**: always use `@page` / `@page_size`; avoid `page_size=5000` unless necessary.
- **`@include_unauthorized = 0`**: smaller JSON when only signed-off results matter.
- **Isolation**: procedure uses `READ UNCOMMITTED` (same spirit as many reporting SPs). For strict consistency, change to `READ COMMITTED` in your own fork.
- **Indexes** (DBA): ensure `tbl_med_mcc_patient_samples.modifieddate` and `vailid` are well-covered for your workload.

---

## 6. Deploy runbook (DBA)

```bash
sqlcmd -S YOUR_SERVER,1433 -d Noble -U deploy_user -P "***" -i sp/usp_listec_worksheet_report_json.sql
sqlcmd -S YOUR_SERVER,1433 -U sa -P "***" -i sp/grant_listec_ro.sql
```

Smoke-test:

```sql
EXEC dbo.usp_listec_worksheet_report_json
    @from_date = CAST(GETDATE() AS date),
    @to_date   = CAST(GETDATE() AS date),
    @page = 1, @page_size = 5;
```

Compare row count (same filters, no pagination) to `usp_worksheet_sample02072020` for regression.

**Read-only check performed during development**: for the calendar day of the test, inline CTE count matched `usp_worksheet_sample02072020`, and sample `FOR JSON` output parsed. Repeat after your deploy.

---

## 7. Copy-paste block for an AI agent in your other repo

Use this verbatim when onboarding another coding agent:

---

You integrate a **SQL Server reporting** call into our **Node.js + TypeScript** app.

**Database**: `Noble` on our SQL Server.  
**Object**: `dbo.usp_listec_worksheet_report_json` (DDL in this bundle: `sp/usp_listec_worksheet_report_json.sql`).

**Behaviour**:

- Input: date range + optional filters (see parameter table in `worksheet-report-sp.md` in this folder).
- Output: result set with one row per sample `sid`; column `results_json` is a **JSON string** — parse to array in application code.
- Use login **listec_ro** with **EXECUTE** on this SP only. Env vars: `LISTEC_SQL_SERVER`, `LISTEC_SQL_DATABASE`, `LISTEC_SQL_USER`, `LISTEC_SQL_PASSWORD`, optional `LISTEC_SQL_TRUST_CERT=true` for on-prem.

**Implementation tasks**:

1. `npm install mssql@^11 dotenv` (+ `express` if exposing HTTP).
2. Copy `integration/node-mssql/listec.types.ts` and `listec.client.ts` into our `src/lib/listec/` (or similar).
3. Add `.env` from `integration/node-mssql/.env.example` — **never commit secrets**.
4. Wrap `fetchWorksheetReports()` in our service layer; map HTTP query params to `WorksheetReportFilters` exactly like `example.express.ts`.
5. Return JSON: `{ count, data }` where each element has `results` as a **parsed array**, not a raw string.
6. Add integration test or manual curl against `/api/worksheet-reports?fromDate=YYYY-MM-DD&toDate=YYYY-MM-DD`.

**Do not** embed `db_owner` credentials from the legacy Web.config.

---

## Model note

This document was produced to support agent-driven integration in a separate codebase; keep the DDL under version control and rotate SQL passwords regularly.
