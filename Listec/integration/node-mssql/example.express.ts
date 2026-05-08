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

const app = express();
const port = Number(process.env.LISTEC_API_PORT ?? process.env.PORT ?? 3100);
const host = process.env.LISTEC_API_HOST ?? '127.0.0.1';

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

/** Query -> WorksheetReportFilters (matches Sample Worksheet UI) */
function filtersFromQuery(q: express.Request['query']): WorksheetReportFilters {
  const fromDate = String(q.fromDate ?? q.from ?? '');
  const toDate = String(q.toDate ?? q.to ?? '');
  if (!fromDate || !toDate) {
    throw new Error('fromDate and toDate are required (YYYY-MM-DD)');
  }

  return {
    fromDate,
    toDate,
    fromHour: parseNum(q.fromHour as string) ?? undefined,
    toHour: parseNum(q.toHour as string) ?? undefined,
    patientName: q.patientName != null && String(q.patientName) !== '' ? String(q.patientName) : null,
    statusId: parseNum(q.statusId as string),
    clientCode: q.clientCode != null && String(q.clientCode) !== '' ? String(q.clientCode) : null,
    sid: q.sid != null && String(q.sid) !== '' ? String(q.sid) : null,
    departmentId: parseNum(q.departmentId as string),
    businessUnitId: parseNum(q.businessUnitId as string),
    testCode: q.testCode != null && String(q.testCode) !== '' ? String(q.testCode) : null,
    pid: parseNum(q.pid as string),
    tatOnly: parseBool(q.tatOnly as string),
    includeUnauthorized:
      parseBool(q.includeUnauthorized as string) === false ? false : undefined,
    page: parseNum(q.page as string) ?? undefined,
    pageSize: parseNum(q.pageSize as string) ?? undefined,
  };
}

app.get('/api/worksheet-reports', async (req, res) => {
  try {
    const f = filtersFromQuery(req.query);
    const rows = await fetchWorksheetReports(f);
    res.json({ count: rows.length, data: rows });
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
    const f = filtersFromQuery(req.query);
    const rows = await fetchAllWorksheetReports(f);
    const summary = aggregatePackages(rows);
    res.json(summary);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(400).json({ error: msg });
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
