/**
 * Minimal Express example — GET /api/worksheet-reports
 *
 * npm install express mssql dotenv
 * npm install -D @types/express @types/node typescript
 *
 * Copy listec.types.ts + listec.client.ts next to this file (or adjust imports).
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
loadEnv({ path: path.resolve(__dirname, '..', '..', '.env') });
loadEnv();
import express from 'express';
import { fetchWorksheetReports, closeListecPool, fetchAllWorksheetReports } from './listec.client';
import type { WorksheetReportFilters } from './listec.types';
import { aggregatePackages } from './listec.aggregate';
import {
    resolveBusinessUnitId,
    resolveDepartmentId,
    resolveStatusId,
    dumpLookups,
    loadMccGeoMap,
    dumpRegionsHierarchy,
} from './listec.lookups';

const app = express();
const port = Number(process.env.LISTEC_API_PORT ?? process.env.PORT ?? 3100);
// Default 0.0.0.0 so api-matter in Docker (LISTEC_API_BASE_URL=http://host.docker.internal:3100)
// can reach Listec on Windows/Mac hosts. Use LISTEC_API_HOST=127.0.0.1 for localhost-only.
const host = process.env.LISTEC_API_HOST ?? '0.0.0.0';

function parseNum(v: string | undefined): number | null {
  if (v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === '1' || v.toLowerCase() === 'true') return true;
  if (v === '0' || v.toLowerCase() === 'false') return false;
  return undefined;
}

function strOrNull(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

interface ResolvedFilters {
  filters: WorksheetReportFilters;
  resolved: {
    businessUnit?: { input: string; id: number | null };
    status?: { input: string; id: number | null };
    department?: { input: string; id: number | null };
  };
  unresolved: string[];
}

/**
 * Build SP filters from a request query. Accepts either numeric ids
 * (`businessUnitId`, `statusId`, `departmentId`) or human-friendly text
 * (`businessUnit`, `status`, `dept`). Text values are resolved against the
 * Noble master tables via cached lookups.
 */
async function filtersFromQuery(q: express.Request['query']): Promise<ResolvedFilters> {
  const fromDate = String(q.fromDate ?? q.from ?? '');
  const toDate = String(q.toDate ?? q.to ?? '');
  if (!fromDate || !toDate) {
    throw new Error('fromDate and toDate are required (YYYY-MM-DD)');
  }

  const resolved: ResolvedFilters['resolved'] = {};
  const unresolved: string[] = [];

  let businessUnitId = parseNum(q.businessUnitId as string);
  const buText = strOrNull(q.businessUnit);
  if (businessUnitId == null && buText) {
    const id = await resolveBusinessUnitId(buText);
    resolved.businessUnit = { input: buText, id };
    if (id != null) businessUnitId = id;
    else unresolved.push(`businessUnit "${buText}" did not match any tbl_med_business_unit_master.BusinessUnitCode/BusinessUnitName`);
  }

  let statusId = parseNum(q.statusId as string);
  const statusText = strOrNull(q.status);
  if (statusId == null && statusText) {
    const id = await resolveStatusId(statusText);
    resolved.status = { input: statusText, id };
    if (id != null) statusId = id;
    else unresolved.push(`status "${statusText}" did not match any sample_status_master.status`);
  }

  let departmentId = parseNum(q.departmentId as string);
  const deptText = strOrNull(q.dept ?? q.deptNo);
  if (departmentId == null && deptText) {
    const id = await resolveDepartmentId(deptText);
    resolved.department = { input: deptText, id };
    if (id != null) departmentId = id;
    else unresolved.push(`department "${deptText}" did not match any tbl_med_department_master.Code/Name`);
  }

  const filters: WorksheetReportFilters = {
    fromDate,
    toDate,
    fromHour: parseNum(q.fromHour as string) ?? undefined,
    toHour: parseNum(q.toHour as string) ?? undefined,
    patientName: strOrNull(q.patientName),
    statusId,
    clientCode: strOrNull(q.clientCode),
    sid: strOrNull(q.sid),
    departmentId,
    businessUnitId,
    testCode: strOrNull(q.testCode),
    pid: parseNum(q.pid as string),
    tatOnly: parseBool(q.tatOnly as string),
    includeUnauthorized: parseBool(q.includeUnauthorized as string) === false ? false : undefined,
    page: parseNum(q.page as string) ?? undefined,
    pageSize: parseNum(q.pageSize as string) ?? undefined,
  };

  return { filters, resolved, unresolved };
}

app.get('/api/worksheet-reports', async (req, res) => {
  try {
    const { filters, resolved, unresolved } = await filtersFromQuery(req.query);
    const rows = await fetchWorksheetReports(filters);
    res.json({ count: rows.length, data: rows, resolved, unresolved });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

/**
 * Drains every page for the filter window and returns rows mapped into
 * { sid, testNamesText } pairs plus pre-computed totals — purpose-built
 * for lis-nav-bot's package-label aggregator.
 */
app.get('/api/worksheet-reports/packages', async (req, res) => {
  try {
    const { filters, resolved, unresolved } = await filtersFromQuery(req.query);
    // Tracer optimisation: when the caller passes `bucketTestCodes=he011,he022,...`
    // we keep the SP `@test_code` filter NULL (returning every SID for the
    // window) and bucket SIDs by test_code in JS afterwards. One SP execution
    // replaces N (one per test code), and the caller can derive any number of
    // mode-specific tile blobs from the single response.
    const bucketRaw = req.query.bucketTestCodes;
    const bucketCodes =
      typeof bucketRaw === 'string' && bucketRaw.trim().length > 0
        ? bucketRaw
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];

    const parseBucketKeys = (raw: unknown): string[] => {
      if (typeof raw !== 'string' || !raw.trim()) return [];
      return [
        ...new Set(
          raw
            .split(',')
            .map((s) => s.trim().toUpperCase())
            .filter(Boolean),
        ),
      ];
    };
    const bucketCities = parseBucketKeys(req.query.bucketCities);
    const bucketStates = parseBucketKeys(req.query.bucketStates);

    let mccGeoLookup: Map<string, { cityKey: string; stateKey: string }> | undefined;
    if (bucketCities.length > 0 || bucketStates.length > 0) {
      const mccMap = await loadMccGeoMap();
      mccGeoLookup = new Map();
      for (const [code, g] of mccMap) {
        mccGeoLookup.set(code, { cityKey: g.cityKey, stateKey: g.stateKey });
      }
    }

    const rows = await fetchAllWorksheetReports(filters);
    const summary = aggregatePackages(rows, {
      bucketCodes,
      bucketCities: bucketCities.length ? bucketCities : undefined,
      bucketStates: bucketStates.length ? bucketStates : undefined,
      mccGeoLookup,
    });
    res.json({ ...summary, resolved, unresolved, filters });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
  }
});

app.get('/api/regions', async (_req, res) => {
  try {
    res.json(await dumpRegionsHierarchy());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/api/lookups', async (_req, res) => {
  try {
    res.json(await dumpLookups());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(port, host, () => {
  console.log(`Worksheet API listening on http://${host}:${port}`);
});

async function shutdown() {
  server.close();
  await closeListecPool();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
