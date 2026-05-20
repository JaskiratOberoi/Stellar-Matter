/**
 * Read-only schema discovery for the BU/branch mapping that LIS uses on
 * the Sample Worksheet page. Tracer / Stellar Matter currently filter
 * samples via `S.business_unit_id = @business_unit_id` (the BU that
 * processed the sample). The LIS UI appears to filter via the client /
 * collection-centre's branch (the BU that collected the sample) — which
 * is why specialty tubes (S.Heparin / L.Heparin etc.) under-count at
 * regional BUs once the central QUGEN lab processes them.
 *
 * This script does NOT mutate anything. It just dumps every column,
 * matching table name, FK edge and the legacy SP body so a human can
 * pick the correct join. Run via `npm run inspect:bu`.
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import sql from 'mssql';

// Match how example.express.ts loads env: workspace root .env, then
// Listec/.env (where the real LISTEC_SQL_* live in this repo), then
// node-mssql/.env (if anyone adds one), then cwd .env.
loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv();

import { getListecPool, closeListecPool } from '../listec.client';

interface ColumnRow {
    COLUMN_NAME: string;
    DATA_TYPE: string;
    CHARACTER_MAXIMUM_LENGTH: number | null;
    IS_NULLABLE: 'YES' | 'NO';
    ORDINAL_POSITION: number;
}

interface FkRow {
    parent_table: string;
    parent_col: string;
    ref_table: string;
    ref_col: string;
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function header(title: string): void {
    process.stdout.write('\n\n## ' + title + '\n');
    process.stdout.write('-'.repeat(Math.min(title.length + 3, 78)) + '\n');
}

async function dumpColumns(pool: sql.ConnectionPool, table: string): Promise<ColumnRow[]> {
    const r = await pool
        .request()
        .input('tn', sql.NVarChar(128), table)
        .query<ColumnRow>(
            `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, ORDINAL_POSITION
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_SCHEMA = 'dbo' AND TABLE_NAME = @tn
             ORDER BY ORDINAL_POSITION`,
        );
    return r.recordset || [];
}

async function dumpCandidateTables(pool: sql.ConnectionPool): Promise<string[]> {
    const r = await pool.request().query<{ name: string }>(`
        SELECT name FROM sys.tables
        WHERE SCHEMA_NAME(schema_id) = 'dbo'
          AND (
                name LIKE '%branch%'
             OR name LIKE '%site%'
             OR name LIKE '%location%'
             OR name LIKE '%region%'
             OR name LIKE '%center%'
             OR name LIKE '%centre%'
             OR name LIKE '%user_client%'
             OR name LIKE '%user_mcc%'
             OR name LIKE '%user_business%'
             OR name LIKE '%bu_master%'
             OR name LIKE '%business%'
          )
        ORDER BY name
    `);
    return (r.recordset || []).map((row) => row.name);
}

async function dumpForeignKeys(pool: sql.ConnectionPool, targetTables: string[]): Promise<FkRow[]> {
    if (targetTables.length === 0) return [];
    const inList = targetTables.map((_, i) => `@t${i}`).join(',');
    const req = pool.request();
    targetTables.forEach((t, i) => req.input(`t${i}`, sql.NVarChar(128), t));
    const r = await req.query<FkRow>(`
        SELECT
            cp.name AS parent_table,
            cp_col.name AS parent_col,
            cr.name AS ref_table,
            cr_col.name AS ref_col
        FROM sys.foreign_keys fk
        INNER JOIN sys.foreign_key_columns fkc
            ON fkc.constraint_object_id = fk.object_id
        INNER JOIN sys.tables cp ON fk.parent_object_id = cp.object_id
        INNER JOIN sys.columns cp_col
            ON cp_col.object_id = fk.parent_object_id AND cp_col.column_id = fkc.parent_column_id
        INNER JOIN sys.tables cr ON fk.referenced_object_id = cr.object_id
        INNER JOIN sys.columns cr_col
            ON cr_col.object_id = fk.referenced_object_id AND cr_col.column_id = fkc.referenced_column_id
        WHERE SCHEMA_NAME(cp.schema_id) = 'dbo' AND SCHEMA_NAME(cr.schema_id) = 'dbo'
          AND (cp.name IN (${inList}) OR cr.name IN (${inList}))
        ORDER BY cp.name, parent_col
    `);
    return r.recordset || [];
}

async function dumpSpModule(pool: sql.ConnectionPool, name: string): Promise<string | null> {
    const r = await pool
        .request()
        .input('n', sql.NVarChar(255), name)
        .query<{ definition: string | null }>(
            `SELECT m.definition
             FROM sys.sql_modules m
             INNER JOIN sys.objects o ON o.object_id = m.object_id
             WHERE o.name = @n AND SCHEMA_NAME(o.schema_id) = 'dbo'`,
        );
    const row = r.recordset?.[0];
    return row?.definition ?? null;
}

type Binding = { type: 'int' | 'str'; value: unknown };

async function countBy(
    pool: sql.ConnectionPool,
    label: string,
    where: string,
    bindings: Record<string, Binding> = {},
): Promise<void> {
    const req = pool.request();
    for (const [k, v] of Object.entries(bindings)) {
        if (v.type === 'int') req.input(k, sql.Int, v.value as number);
        else req.input(k, sql.NVarChar(100), v.value as string);
    }
    const q = `
        SELECT COUNT(DISTINCT S.vailid) AS n
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U ON P.mcc_code = U.id
        WHERE S.modifieddate BETWEEN '2026-05-01' AND '2026-05-31 23:59:59'
          AND S.sample_status > 1
          ${where}
    `;
    try {
        const r = await req.query<{ n: number }>(q);
        process.stdout.write(`  ${pad(label, 60)} = ${r.recordset?.[0]?.n ?? '?'}\n`);
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(`  ${pad(label, 60)} = ERROR: ${msg.slice(0, 140)}\n`);
    }
}

async function topClientPrefixes(
    pool: sql.ConnectionPool,
    label: string,
    where: string,
    bindings: Record<string, Binding> = {},
): Promise<void> {
    const req = pool.request();
    for (const [k, v] of Object.entries(bindings)) {
        if (v.type === 'int') req.input(k, sql.Int, v.value as number);
        else req.input(k, sql.NVarChar(100), v.value as string);
    }
    const q = `
        SELECT TOP 12 LEFT(U.MCCUnitCode, 3) AS prefix, COUNT(DISTINCT S.vailid) AS n
        FROM dbo.tbl_med_mcc_patient_samples S
        INNER JOIN dbo.tbl_med_mcc_patient_master P ON S.patient_id = P.id
        INNER JOIN dbo.tbl_med_mcc_unit_master U ON P.mcc_code = U.id
        WHERE S.modifieddate BETWEEN '2026-05-01' AND '2026-05-31 23:59:59'
          AND S.sample_status > 1
          ${where}
        GROUP BY LEFT(U.MCCUnitCode, 3)
        ORDER BY n DESC
    `;
    try {
        const r = await req.query<{ prefix: string; n: number }>(q);
        process.stdout.write(`  ${label} client-prefix top-12:\n`);
        for (const row of r.recordset || []) {
            process.stdout.write(`    ${pad(String(row.prefix ?? '?'), 6)} ${row.n}\n`);
        }
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        process.stdout.write(`  ${label} prefix probe ERROR: ${msg.slice(0, 140)}\n`);
    }
}

async function main(): Promise<void> {
    const pool = await getListecPool();

    header('1. tbl_med_mcc_unit_master columns (full list)');
    const cols = await dumpColumns(pool, 'tbl_med_mcc_unit_master');
    if (cols.length === 0) {
        process.stdout.write('  (no columns — listec_ro may lack INFORMATION_SCHEMA access)\n');
    } else {
        process.stdout.write(
            `  ${pad('#', 3)} ${pad('column', 32)} ${pad('type', 18)} ${pad('len', 6)} null\n`,
        );
        for (const c of cols) {
            const len = c.CHARACTER_MAXIMUM_LENGTH == null ? '' : String(c.CHARACTER_MAXIMUM_LENGTH);
            process.stdout.write(
                `  ${pad(String(c.ORDINAL_POSITION), 3)} ${pad(c.COLUMN_NAME, 32)} ${pad(c.DATA_TYPE, 18)} ${pad(len, 6)} ${c.IS_NULLABLE}\n`,
            );
        }
    }

    header('2. tbl_med_business_unit_master columns');
    const buCols = await dumpColumns(pool, 'tbl_med_business_unit_master');
    for (const c of buCols) {
        process.stdout.write(`  ${pad(c.COLUMN_NAME, 32)} ${c.DATA_TYPE}\n`);
    }

    header('3. dbo tables matching branch/site/location/region/center/business/user_client');
    const candidates = await dumpCandidateTables(pool);
    for (const t of candidates) process.stdout.write(`  ${t}\n`);

    const allTargets = ['tbl_med_mcc_unit_master', 'tbl_med_business_unit_master', ...candidates];
    header('4. Foreign keys touching the candidate tables (both directions)');
    const fks = await dumpForeignKeys(pool, allTargets);
    for (const fk of fks) {
        process.stdout.write(`  ${pad(fk.parent_table + '.' + fk.parent_col, 56)} -> ${fk.ref_table}.${fk.ref_col}\n`);
    }

    header('5. Per-candidate-table column dump');
    for (const t of candidates) {
        const cs = await dumpColumns(pool, t);
        process.stdout.write(`  ${t} (${cs.length} cols):\n`);
        for (const c of cs) {
            process.stdout.write(`    ${pad(c.COLUMN_NAME, 32)} ${c.DATA_TYPE}\n`);
        }
    }

    header('6. tbl_med_mcc_unit_master TOP 3 rows (every column)');
    try {
        const r = await pool
            .request()
            .query<Record<string, unknown>>('SELECT TOP 3 * FROM dbo.tbl_med_mcc_unit_master ORDER BY id DESC');
        for (let i = 0; i < r.recordset.length; i++) {
            process.stdout.write(`  -- row ${i + 1} --\n`);
            for (const [k, v] of Object.entries(r.recordset[i] ?? {})) {
                process.stdout.write(`    ${pad(k, 32)} = ${v == null ? '<null>' : String(v).slice(0, 80)}\n`);
            }
        }
    } catch (e) {
        process.stdout.write(`  ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    header('7. Legacy SP body (dbo.usp_worksheet_sample02072020) — for BU filter parity');
    try {
        const body = await dumpSpModule(pool, 'usp_worksheet_sample02072020');
        if (!body) process.stdout.write('  (SP not found on this server)\n');
        else process.stdout.write(body + '\n');
    } catch (e) {
        process.stdout.write(`  ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    }

    header('8. Sanity counts for LUCKNOW, May 2026 (sample_status > 1 always)');
    const luBuId = 15;
    await countBy(pool, 'no BU filter, no testCode', '');
    await countBy(pool, 'S.business_unit_id = 15 (current behaviour)', 'AND S.business_unit_id = @bu', {
        bu: { type: 'int', value: luBuId },
    });
    await countBy(
        pool,
        "client codes starting with 'LK' (Lucknow prefix proxy)",
        "AND (U.MCCUnitCode LIKE 'LK%' OR U.MCCUnitCode LIKE 'LKO%' OR U.MCCUnitCode LIKE 'LKW%')",
    );

    process.stdout.write('\n  --- per-test-code under each filter ---\n');
    for (const code of ['ms091', 'cp3257', 'ky004']) {
        process.stdout.write(`\n  testCode = ${code}\n`);
        const ec = `AND (S.testcodes LIKE '%' + @tc + '%' OR EXISTS (SELECT 1 FROM dbo.tbl_med_mcc_patient_test_result r WHERE r.vailid = S.vailid AND (r.testcode = @tc OR r.testname LIKE '%' + @tc + '%')))`;
        await countBy(pool, '  no BU filter', ec, { tc: { type: 'str', value: code } });
        await countBy(pool, '  S.business_unit_id = 15', `AND S.business_unit_id = @bu ${ec}`, {
            bu: { type: 'int', value: luBuId },
            tc: { type: 'str', value: code },
        });
        await countBy(pool, "  client LIKE 'LK%/LKO%/LKW%'", `AND (U.MCCUnitCode LIKE 'LK%') ${ec}`, {
            tc: { type: 'str', value: code },
        });
        await topClientPrefixes(pool, `    ${code}, no BU filter`, ec, {
            tc: { type: 'str', value: code },
        });
    }
}

main()
    .then(() => closeListecPool())
    .then(() => {
        process.stdout.write('\n\nInspect complete.\n');
        process.exit(0);
    })
    .catch(async (e) => {
        process.stderr.write(`Inspect failed: ${e instanceof Error ? e.stack || e.message : String(e)}\n`);
        try {
            await closeListecPool();
        } catch {
            /* ignore */
        }
        process.exit(1);
    });
