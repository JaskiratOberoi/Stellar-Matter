/**
 * Read-only schema discovery for Noble.dbo.tbl_med_mcc_unit_master.
 *
 * Run via: `npm run inspect:mcc` (from Listec/integration/node-mssql/).
 *
 * Output is the source of truth for picking which columns the
 * `client_locations` Postgres mirror should carry. The script does NOT
 * write to MSSQL; it issues SELECT-only statements. Designed so the
 * stdout can be redirected into a Markdown snippet for the PR description.
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import sql from 'mssql';

loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '..', '.env') });
loadEnv({ path: path.resolve(__dirname, '..', '.env') });
loadEnv();

import { getListecPool, closeListecPool } from '../listec.client';

interface ColumnRow {
    COLUMN_NAME: string;
    DATA_TYPE: string;
    CHARACTER_MAXIMUM_LENGTH: number | null;
    IS_NULLABLE: 'YES' | 'NO';
    COLUMN_DEFAULT: string | null;
    ORDINAL_POSITION: number;
}

interface CountRow {
    total: number;
    distinct_cities: number;
    distinct_states: number;
    distinct_business_units: number | null;
    nonempty_codes: number;
}

function pad(s: string, n: number): string {
    return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function fmtCell(v: unknown): string {
    if (v == null) return '<null>';
    if (v instanceof Date) return v.toISOString();
    const s = String(v);
    return s.length > 60 ? s.slice(0, 57) + '...' : s;
}

async function main(): Promise<void> {
    const pool = await getListecPool();

    process.stdout.write('=== tbl_med_mcc_unit_master columns ===\n');
    const cols = await pool
        .request()
        .input('table_name', sql.NVarChar(128), 'tbl_med_mcc_unit_master')
        .query<ColumnRow>(
            `SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE, COLUMN_DEFAULT, ORDINAL_POSITION
             FROM INFORMATION_SCHEMA.COLUMNS
             WHERE TABLE_NAME = @table_name AND TABLE_SCHEMA = 'dbo'
             ORDER BY ORDINAL_POSITION`,
        );

    if (cols.recordset.length === 0) {
        process.stdout.write(
            '  (no columns found — check that listec_ro can SELECT INFORMATION_SCHEMA on Noble)\n',
        );
    } else {
        process.stdout.write(
            `  ${pad('#', 3)} ${pad('column', 32)} ${pad('type', 18)} ${pad('len', 6)} ${pad('null', 5)} default\n`,
        );
        for (const c of cols.recordset) {
            const len = c.CHARACTER_MAXIMUM_LENGTH == null ? '' : String(c.CHARACTER_MAXIMUM_LENGTH);
            process.stdout.write(
                `  ${pad(String(c.ORDINAL_POSITION), 3)} ${pad(c.COLUMN_NAME, 32)} ${pad(c.DATA_TYPE, 18)} ${pad(len, 6)} ${pad(c.IS_NULLABLE, 5)} ${c.COLUMN_DEFAULT ?? ''}\n`,
            );
        }
    }

    process.stdout.write('\n=== Sample rows (TOP 5) ===\n');
    const sample = await pool
        .request()
        .query<Record<string, unknown>>(
            `SELECT TOP 5 * FROM dbo.tbl_med_mcc_unit_master ORDER BY id DESC`,
        );

    if (sample.recordset.length === 0) {
        process.stdout.write('  (table is empty)\n');
    } else {
        const keys = Object.keys(sample.recordset[0] ?? {});
        for (let i = 0; i < sample.recordset.length; i++) {
            process.stdout.write(`  -- row ${i + 1} --\n`);
            for (const k of keys) {
                process.stdout.write(`    ${pad(k, 32)} = ${fmtCell(sample.recordset[i][k])}\n`);
            }
        }
    }

    process.stdout.write('\n=== Counts ===\n');
    let countQuery =
        `SELECT
            COUNT(*) AS total,
            COUNT(DISTINCT City) AS distinct_cities,
            COUNT(DISTINCT State) AS distinct_states,
            SUM(CASE WHEN MCCUnitCode IS NOT NULL AND LTRIM(RTRIM(MCCUnitCode)) <> '' THEN 1 ELSE 0 END) AS nonempty_codes
         FROM dbo.tbl_med_mcc_unit_master`;
    let hasBusinessUnitId = false;
    if (cols.recordset.some((c) => c.COLUMN_NAME === 'BusinessUnitId')) {
        hasBusinessUnitId = true;
        countQuery =
            `SELECT
                COUNT(*) AS total,
                COUNT(DISTINCT City) AS distinct_cities,
                COUNT(DISTINCT State) AS distinct_states,
                COUNT(DISTINCT BusinessUnitId) AS distinct_business_units,
                SUM(CASE WHEN MCCUnitCode IS NOT NULL AND LTRIM(RTRIM(MCCUnitCode)) <> '' THEN 1 ELSE 0 END) AS nonempty_codes
             FROM dbo.tbl_med_mcc_unit_master`;
    }
    const counts = await pool.request().query<CountRow>(countQuery);
    const c = counts.recordset[0];
    if (c) {
        process.stdout.write(`  total                   = ${c.total}\n`);
        process.stdout.write(`  distinct cities         = ${c.distinct_cities}\n`);
        process.stdout.write(`  distinct states         = ${c.distinct_states}\n`);
        if (hasBusinessUnitId) {
            process.stdout.write(`  distinct business units = ${c.distinct_business_units}\n`);
        }
        process.stdout.write(`  rows with non-empty code= ${c.nonempty_codes}\n`);
    }

    process.stdout.write('\n=== City frequency (TOP 15) ===\n');
    const topCities = await pool
        .request()
        .query<{ City: string | null; n: number }>(
            `SELECT TOP 15 City, COUNT(*) AS n
             FROM dbo.tbl_med_mcc_unit_master
             GROUP BY City
             ORDER BY n DESC`,
        );
    for (const row of topCities.recordset) {
        process.stdout.write(`  ${pad(String(row.City ?? '<null>'), 32)} ${row.n}\n`);
    }

    process.stdout.write('\n=== State frequency (TOP 15) ===\n');
    const topStates = await pool
        .request()
        .query<{ State: string | null; n: number }>(
            `SELECT TOP 15 State, COUNT(*) AS n
             FROM dbo.tbl_med_mcc_unit_master
             GROUP BY State
             ORDER BY n DESC`,
        );
    for (const row of topStates.recordset) {
        process.stdout.write(`  ${pad(String(row.State ?? '<null>'), 32)} ${row.n}\n`);
    }
}

main()
    .then(() => closeListecPool())
    .then(() => {
        process.stdout.write('\nInspect complete.\n');
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
