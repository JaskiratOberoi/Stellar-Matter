/**
 * Read-only schema discovery for Tracer LISTEC_SALES_* overrides (Noble dbo).
 *
 * Run via: `npm run inspect:sales` (from Listec/integration/node-mssql/).
 *
 * Uses the same dotenv paths as inspect-mcc.ts. SELECT-only against SQL Server.
 * For a one-off metadata sweep you may temporarily use a high-privilege login
 * (e.g. nobleone) in Listec/.env — remove it afterward; do not commit secrets.
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import sql from 'mssql';

loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv();

import { getListecPool, closeListecPool } from '../listec.client';
import {
  forceDiscoverSalesSchema,
  loadDboForeignKeys,
  readSalesSchemaFromEnv,
  type SalesFkEdge,
  type SalesSchemaResolved,
} from '../listec.salesUsers';

const MCC_TABLE = 'tbl_med_mcc_unit_master';

function isSafeIdentifier(name: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name);
}

function section(title: string): void {
  console.log('');
  console.log(`=== ${title} ===`);
}

function printEnvSalesKeys(): void {
  section('LISTEC_SALES_* (values redacted)');
  const keys = Object.keys(process.env)
    .filter((k) => k.startsWith('LISTEC_SALES_'))
    .sort();
  if (keys.length === 0) {
    console.log('(none set)');
    return;
  }
  for (const k of keys) {
    const v = process.env[k];
    const set = v != null && String(v).trim() !== '';
    console.log(`  ${k}=${set ? '(set)' : '(empty)'}`);
  }
  const resolved = readSalesSchemaFromEnv();
  console.log(
    `  readSalesSchemaFromEnv(): ${resolved ? 'ACTIVE (five required keys + overrides applied)' : 'inactive (need MAP_* + USER_TABLE + USER_PK at minimum)'}`,
  );
}

function printFkEdges(edges: SalesFkEdge[]): void {
  section(`dbo foreign keys (${edges.length} column edges)`);
  const wTable = Math.max(20, ...edges.map((e) => e.parentTable.length), 8);
  const wCol = Math.max(12, ...edges.map((e) => e.parentCol.length));
  console.log(
    `${pad('parent_table', wTable)} ${pad('parent_col', wCol)} -> ${pad('ref_table', wTable)} ref_col`,
  );
  for (const e of edges) {
    console.log(
      `${pad(e.parentTable, wTable)} ${pad(e.parentCol, wCol)} -> ${pad(e.refTable, wTable)} ${e.refCol}`,
    );
  }
}

function printMccGraph(edges: SalesFkEdge[]): void {
  section(`FK references to ${MCC_TABLE}`);
  const toMcc = edges.filter((e) => e.refTable === MCC_TABLE);
  if (toMcc.length === 0) {
    console.log(`(no FK edges point to ${MCC_TABLE})`);
    return;
  }
  const mapTables = [...new Set(toMcc.map((e) => e.parentTable))];
  console.log(`Map-style parent tables (${mapTables.length}): ${mapTables.join(', ')}`);
  for (const mapTable of mapTables) {
    const towardMcc = toMcc.filter((e) => e.parentTable === mapTable);
    console.log(`  ${mapTable}:`);
    for (const e of towardMcc) {
      console.log(`    ${e.parentCol} -> ${MCC_TABLE}.${e.refCol}`);
    }
    const fromMap = edges.filter((e) => e.parentTable === mapTable && e.refTable !== MCC_TABLE);
    if (fromMap.length === 0) {
      console.log('    (no other FKs from this table — unexpected for user↔MCC map)');
      continue;
    }
    console.log('    Other FKs from map table (candidate user / lookup refs):');
    for (const e of fromMap) {
      console.log(`    ${e.parentCol} -> ${e.refTable}.${e.refCol}`);
    }
  }
}

interface InfoCol {
  COLUMN_NAME: string;
  DATA_TYPE: string;
  CHARACTER_MAXIMUM_LENGTH: number | null;
  IS_NULLABLE: string;
}

async function loadInfoColumns(pool: sql.ConnectionPool, table: string): Promise<InfoCol[]> {
  const r = await pool
    .request()
    .input('tn', sql.NVarChar(128), table)
    .query<InfoCol>(
      `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @tn
       ORDER BY ORDINAL_POSITION`,
    );
  return r.recordset || [];
}

function printColumns(title: string, cols: InfoCol[]): void {
  console.log(`--- ${title} (${cols.length} columns) ---`);
  const wName = Math.max(28, ...cols.map((c) => c.COLUMN_NAME.length));
  for (const c of cols) {
    const len =
      c.CHARACTER_MAXIMUM_LENGTH != null && c.CHARACTER_MAXIMUM_LENGTH > 0
        ? `(${c.CHARACTER_MAXIMUM_LENGTH})`
        : '';
    console.log(
      `  ${pad(c.COLUMN_NAME, wName)}  ${String(c.DATA_TYPE)}${len}  ${c.IS_NULLABLE === 'YES' ? 'NULL' : 'NOT NULL'}`,
    );
  }
}

async function printSampleDiscriminator(
  pool: sql.ConnectionPool,
  s: SalesSchemaResolved,
): Promise<void> {
  section('Sample values (TOP 20 DISTINCT) for Sales/Marketing discriminator');
  let table: string | null = null;
  let col: string | null = null;
  if (s.userTypeInlineCol) {
    table = s.userTable;
    col = s.userTypeInlineCol;
    console.log(`Using inline column on user table: dbo.${table}.${col}`);
  } else if (s.typeTable && s.typeNameCol) {
    table = s.typeTable;
    col = s.typeNameCol;
    console.log(`Using type master name column: dbo.${table}.${col}`);
  } else {
    console.log(
      'No varchar sample path: discovery did not find userTypeInlineCol or (typeTable + typeNameCol).',
    );
    console.log('Set LISTEC_SALES_* overrides from the column lists above, then rerun.');
    return;
  }
  if (!isSafeIdentifier(table) || !isSafeIdentifier(col)) {
    console.log('Refusing dynamic SQL: table/column failed identifier validation.');
    return;
  }
  const dt = (await loadInfoColumns(pool, table)).find((c) => c.COLUMN_NAME === col);
  const dtype = (dt?.DATA_TYPE || '').toLowerCase();
  if (!dtype.includes('char') && !['text', 'ntext'].includes(dtype)) {
    console.log(`Column ${col} is type ${dt?.DATA_TYPE || 'unknown'} — skipping DISTINCT sample (not string-like).`);
    return;
  }
  const q = `
    SELECT DISTINCT TOP (20) LTRIM(RTRIM(CAST(${quoteIdent(col)} AS NVARCHAR(400)))) AS v
    FROM dbo.${quoteIdent(table)}
    WHERE ${quoteIdent(col)} IS NOT NULL
    ORDER BY v
  `;
  try {
    const r = await pool.request().query<{ v: string }>(q);
    const rows = r.recordset || [];
    if (rows.length === 0) {
      console.log('(no non-null rows in sample)');
      return;
    }
    for (const row of rows) {
      console.log(`  ${String(row.v)}`);
    }
  } catch (e) {
    console.log(`Sample query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Bracket-quote a single identifier for use inside dbo.<name> only. */
function quoteIdent(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

async function main(): Promise<void> {
  console.log('inspect-sales-mapping — Noble dbo schema hints for LISTEC_SALES_*');
  printEnvSalesKeys();

  const pool = await getListecPool();
  try {
    const edges = await loadDboForeignKeys(pool);
    printFkEdges(edges);
    printMccGraph(edges);

    section('Resolved schema (forceDiscoverSalesSchema — matches listec.salesUsers discovery)');
    let s: SalesSchemaResolved;
    try {
      s = await forceDiscoverSalesSchema(pool);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.log(`Discovery error:\n${msg}`);
      console.log(
        '(Fix LISTEC_SALES_* in .env per .env.example Tracer block, or grant read metadata on Noble.)',
      );
      return;
    }
    console.log(JSON.stringify(s, null, 2));

    const userCols = await loadInfoColumns(pool, s.userTable);
    printColumns(`dbo.${s.userTable}`, userCols);

    if (s.typeTable) {
      const typeCols = await loadInfoColumns(pool, s.typeTable);
      printColumns(`dbo.${s.typeTable}`, typeCols);
    } else {
      console.log('');
      console.log('(no separate type table on resolved schema — inline or missing FK path)');
    }

    await printSampleDiscriminator(pool, s);

    section('Next steps');
    console.log(
      'Map printed names into LISTEC_SALES_* in Listec/.env (see integration/node-mssql/.env.example).',
    );
    console.log('Restart listec and GET /api/tracer/sales-marketing-users.');
  } finally {
    await closeListecPool();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
