/**
 * Drop-in client for Noble.dbo.usp_listec_worksheet_report_json
 *
 * npm install mssql
 *
 * Environment (see .env.example):
 *   LISTEC_SQL_SERVER, LISTEC_SQL_DATABASE, LISTEC_SQL_USER, LISTEC_SQL_PASSWORD
 */

import sql from 'mssql';
import type { WorksheetReportFilters, WorksheetReportRow, TestResult } from './listec.types';

let poolPromise: Promise<sql.ConnectionPool> | null = null;

/**
 * Page size used when draining every page for a filter window.
 *
 * The SP paginates with `OFFSET @offset ROWS FETCH NEXT @size ROWS ONLY`, so
 * each page re-scans and discards everything before it — per-page cost grows
 * with depth and a full drain is quadratic in the row count. Measured against
 * the largest BU (id 1, one month): page 1 = 0.58s, page 25 = 6.4s,
 * page 50 = 12.9s, plateauing near 15s. At 1000 rows/page that BU needs ~65
 * pages ≈ 10 minutes, which blows past the 300s undici default in the tracer's
 * `fetch()` and fails the unit outright.
 *
 * 5000 is the SP's own clamp ceiling (@page_size > 5000 -> 5000), so this is
 * the fewest round trips the procedure will allow. Same window at 5000/page
 * measured 122s end to end. Override with LISTEC_DRAIN_PAGE_SIZE if the LIS
 * box needs gentler batches.
 */
const DEFAULT_DRAIN_PAGE_SIZE = Math.min(
  Math.max(Number(process.env.LISTEC_DRAIN_PAGE_SIZE) || 5000, 1),
  5000,
);

/** Split `host` or `host,port` (mirrors SQL Server connection-string convention). */
function splitServer(raw: string): { host: string; port: number | undefined } {
  const trimmed = raw.trim();
  const m = /^(.+?)[,:](\d+)$/.exec(trimmed);
  if (m) return { host: m[1].trim(), port: Number(m[2]) };
  return { host: trimmed, port: undefined };
}

export function getListecPoolConfig(): sql.config {
  const rawServer = process.env.LISTEC_SQL_SERVER;
  const database = process.env.LISTEC_SQL_DATABASE ?? 'Noble';
  const user = process.env.LISTEC_SQL_USER;
  const password = process.env.LISTEC_SQL_PASSWORD;

  if (!rawServer || !user || password === undefined) {
    throw new Error(
      'Missing LISTEC_SQL_SERVER / LISTEC_SQL_USER / LISTEC_SQL_PASSWORD environment variables.',
    );
  }

  const { host, port } = splitServer(rawServer);

  return {
    server: host,
    port,
    database,
    user,
    password,
    options: {
      encrypt: process.env.LISTEC_SQL_ENCRYPT !== 'false',
      trustServerCertificate: process.env.LISTEC_SQL_TRUST_CERT === 'true',
      appName: process.env.LISTEC_SQL_APP_NAME ?? 'ListecWorksheetReport',
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    connectionTimeout: Number(process.env.LISTEC_SQL_CONNECT_TIMEOUT_MS ?? 15_000),
    requestTimeout: Number(process.env.LISTEC_SQL_REQUEST_TIMEOUT_MS ?? 120_000),
  };
}

/** Singleton connection pool (one per process). */
export async function getListecPool(): Promise<sql.ConnectionPool> {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(getListecPoolConfig()).connect();
  }
  return poolPromise;
}

export async function closeListecPool(): Promise<void> {
  if (poolPromise) {
    const p = await poolPromise;
    await p.close();
    poolPromise = null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Raised when the caller hangs up (or explicitly aborts) while a drain is in
 * flight. Distinct from a SQL error so retry and HTTP layers can treat a
 * deliberate cancellation as "stop", not "something broke".
 */
export class QueryAbortedError extends Error {
  readonly aborted = true;

  constructor(message = 'Query aborted by caller') {
    super(message);
    this.name = 'QueryAbortedError';
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new QueryAbortedError();
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      // A cancelled request surfaces as "Canceled." / ECANCEL, which matches
      // the transient heuristic below. Retrying it would re-issue the very
      // scan the caller just asked us to stop.
      if (e instanceof QueryAbortedError) throw e;
      const msg = String(e);
      const transient =
        msg.includes('ETIMEOUT') ||
        msg.includes('ECONNRESET') ||
        msg.includes('failed') ||
        msg.includes('deadlock');
      if (!transient || i === attempts - 1) throw e;
      await sleep(200 * (i + 1));
    }
  }
  throw last;
}

/**
 * Execute a stored procedure, cancelling the in-flight request if `signal`
 * fires. `request.cancel()` sends a TDS attention packet, so MSSQL stops the
 * scan on the LIS box instead of running it to completion into a socket
 * nobody is reading any more.
 */
async function executeProcedure(
  pool: sql.ConnectionPool,
  procedure: string,
  bind: (req: sql.Request) => void,
  signal?: AbortSignal,
): Promise<WorksheetReportRow[]> {
  throwIfAborted(signal);
  const req = pool.request();
  bind(req);

  const onAbort = () => {
    try {
      req.cancel();
    } catch {
      /* request already settled — nothing to cancel */
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const result = await req.execute<Record<string, unknown>>(procedure);
    const set = result.recordsets[0];
    if (!set) return [];
    return [...set].map((row) => rowToReportRow(row as Record<string, unknown>));
  } catch (e) {
    if (signal?.aborted) throw new QueryAbortedError(`Aborted during ${procedure}`);
    throw e;
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

function parseResultsJson(raw: string | null): TestResult[] {
  if (raw == null || raw === '' || raw === '[]') return [];
  try {
    const parsed = JSON.parse(raw) as TestResult[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function rowToReportRow(r: Record<string, unknown>): WorksheetReportRow {
  const resultsJson = r.results_json as string | null;
  return {
    client_code: (r.client_code as string) ?? null,
    business_unit: (r.business_unit as string) ?? null,
    pid: Number(r.pid),
    patient_name: (r.patient_name as string) ?? null,
    sex: (r.sex as string) ?? null,
    age: r.age == null ? null : Number(r.age),
    age_unit: (r.age_unit as string) ?? null,
    sid: String(r.sid),
    sample_drawn: r.sample_drawn == null ? null : String(r.sample_drawn),
    regd_at: r.regd_at == null ? null : String(r.regd_at),
    last_modified_at: r.last_modified_at == null ? null : String(r.last_modified_at),
    status_code: r.status_code == null ? null : Number(r.status_code),
    status: (r.status as string) ?? null,
    test_names_csv: (r.test_names_csv as string) ?? null,
    order_number: (r.order_number as string) ?? null,
    bill_number: (r.bill_number as string) ?? null,
    sample_comments: (r.sample_comments as string) ?? null,
    clinical_history: (r.clinical_history as string) ?? null,
    tat: r.tat == null ? null : String(r.tat),
    results: parseResultsJson(resultsJson),
  };
}

/**
 * Call dbo.usp_listec_worksheet_report_json with filters.
 * Null/undefined optional filters become SQL NULL (meaning "no filter").
 */
export async function fetchWorksheetReports(
  f: WorksheetReportFilters,
  signal?: AbortSignal,
): Promise<WorksheetReportRow[]> {
  const pool = await getListecPool();

  return withRetry(() =>
    executeProcedure(
      pool,
      'dbo.usp_listec_worksheet_report_json',
      (req) => {
        req.input('from_date', sql.Date, f.fromDate);
        req.input('to_date', sql.Date, f.toDate);
        req.input('from_hour', sql.TinyInt, f.fromHour ?? 0);
        req.input('to_hour', sql.TinyInt, f.toHour ?? 24);
        req.input('patient_name', sql.NVarChar(200), f.patientName ?? null);
        req.input('status_id', sql.Int, f.statusId ?? null);
        req.input('client_code', sql.NVarChar(50), f.clientCode ?? null);
        req.input('sid', sql.NVarChar(50), f.sid ?? null);
        req.input('department_id', sql.Int, f.departmentId ?? null);
        req.input('business_unit_id', sql.Int, f.businessUnitId ?? null);
        req.input('test_code', sql.NVarChar(50), f.testCode ?? null);
        req.input('pid', sql.Int, f.pid ?? null);
        req.input('tat_only', sql.Bit, f.tatOnly ? 1 : 0);
        req.input('include_unauthorized', sql.Bit, f.includeUnauthorized === false ? 0 : 1);
        req.input('page', sql.Int, f.page ?? 1);
        req.input('page_size', sql.Int, f.pageSize ?? 500);
      },
      signal,
    ),
  );
}

/**
 * Drain every page for the given filter window. Walks pages of `pageSize`
 * (defaults to DEFAULT_DRAIN_PAGE_SIZE) until a partial page or a hard cap is
 * reached. Use this when you need the full result set for aggregation.
 */
export async function fetchAllWorksheetReports(
  filters: WorksheetReportFilters,
  opts: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<WorksheetReportRow[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? filters.pageSize ?? DEFAULT_DRAIN_PAGE_SIZE, 1), 5000);
  const maxPages = opts.maxPages ?? 100;
  const out: WorksheetReportRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    throwIfAborted(opts.signal);
    const batch = await fetchWorksheetReports({ ...filters, page, pageSize }, opts.signal);
    out.push(...batch);
    if (batch.length < pageSize) return out;
  }
  // Fell out of the loop on the page cap rather than a short page, so there is
  // very likely more data the caller never saw. Aggregates built on this are
  // undercounts — say so rather than returning a truncated set silently.
  console.warn(
    `[listec] fetchAllWorksheetReports hit the ${maxPages}-page cap at ${pageSize}/page ` +
      `(${out.length} rows); results may be incomplete for ${JSON.stringify({
        fromDate: filters.fromDate,
        toDate: filters.toDate,
        businessUnitId: filters.businessUnitId,
      })}.`,
  );
  return out;
}

/**
 * Build the dbo.ClientCodeList TVP from a deduped uppercased code list.
 * Returns an mssql.Table ready to be passed to req.input(name, table).
 */
function buildClientCodeListTvp(codes: string[]): sql.Table {
  const table = new sql.Table('dbo.ClientCodeList');
  table.create = false;
  table.columns.add('code', sql.NVarChar(50), { nullable: false, primary: true });
  const seen = new Set<string>();
  for (const raw of codes) {
    const c = String(raw ?? '').trim();
    if (!c) continue;
    const upper = c.toUpperCase();
    if (seen.has(upper)) continue;
    seen.add(upper);
    table.rows.add(upper);
  }
  return table;
}

/**
 * Phase 12: client_codes-filtered worksheet pull. Calls
 * dbo.usp_listec_worksheet_report_by_codes — same row shape as
 * fetchWorksheetReports, except the per-call `clientCode LIKE` filter is
 * replaced with an exact-match list (TVP). Pass an empty array to fall back
 * to "no filter" semantics (matches the SP's @codeCount = 0 branch).
 */
export async function fetchWorksheetReportsByCodes(
  f: Omit<WorksheetReportFilters, 'clientCode'>,
  codes: string[],
  signal?: AbortSignal,
): Promise<WorksheetReportRow[]> {
  const pool = await getListecPool();
  return withRetry(() =>
    executeProcedure(
      pool,
      'dbo.usp_listec_worksheet_report_by_codes',
      (req) => {
        req.input('from_date', sql.Date, f.fromDate);
        req.input('to_date', sql.Date, f.toDate);
        req.input('from_hour', sql.TinyInt, f.fromHour ?? 0);
        req.input('to_hour', sql.TinyInt, f.toHour ?? 24);
        req.input('patient_name', sql.NVarChar(200), f.patientName ?? null);
        req.input('status_id', sql.Int, f.statusId ?? null);
        req.input('sid', sql.NVarChar(50), f.sid ?? null);
        req.input('department_id', sql.Int, f.departmentId ?? null);
        req.input('business_unit_id', sql.Int, f.businessUnitId ?? null);
        req.input('test_code', sql.NVarChar(50), f.testCode ?? null);
        req.input('pid', sql.Int, f.pid ?? null);
        req.input('tat_only', sql.Bit, f.tatOnly ? 1 : 0);
        req.input('include_unauthorized', sql.Bit, f.includeUnauthorized === false ? 0 : 1);
        req.input('page', sql.Int, f.page ?? 1);
        req.input('page_size', sql.Int, f.pageSize ?? 500);
        req.input('client_codes', buildClientCodeListTvp(codes));
      },
      signal,
    ),
  );
}

/**
 * Drain every page for the by-codes SP. Mirrors fetchAllWorksheetReports.
 */
export async function fetchAllWorksheetReportsByCodes(
  filters: Omit<WorksheetReportFilters, 'clientCode'>,
  codes: string[],
  opts: { pageSize?: number; maxPages?: number; signal?: AbortSignal } = {},
): Promise<WorksheetReportRow[]> {
  const pageSize = Math.min(Math.max(opts.pageSize ?? filters.pageSize ?? DEFAULT_DRAIN_PAGE_SIZE, 1), 5000);
  const maxPages = opts.maxPages ?? 100;
  const out: WorksheetReportRow[] = [];
  for (let page = 1; page <= maxPages; page++) {
    throwIfAborted(opts.signal);
    const batch = await fetchWorksheetReportsByCodes({ ...filters, page, pageSize }, codes, opts.signal);
    out.push(...batch);
    if (batch.length < pageSize) return out;
  }
  console.warn(
    `[listec] fetchAllWorksheetReportsByCodes hit the ${maxPages}-page cap at ${pageSize}/page ` +
      `(${out.length} rows, ${codes.length} client codes); results may be incomplete for ` +
      `${JSON.stringify({ fromDate: filters.fromDate, toDate: filters.toDate })}.`,
  );
  return out;
}
