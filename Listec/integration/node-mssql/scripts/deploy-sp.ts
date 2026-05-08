/**
 * Deploy a .sql file (split on `GO` batch separators) against the Noble
 * database using the same connection settings as the runtime client.
 *
 * Usage:
 *   npx ts-node scripts/deploy-sp.ts ../sp/usp_listec_worksheet_report_json.sql
 *
 * After deploy, runs a 1-row smoke test against
 * dbo.usp_listec_worksheet_report_json so we know the SP is callable and
 * results_json parses.
 */

import { config as loadEnv } from 'dotenv';
import path from 'path';
import fs from 'fs';
import sql from 'mssql';

loadEnv({ path: path.resolve(__dirname, '..', '..', '..', '.env') });
loadEnv();

import { getListecPoolConfig } from '../listec.client';

function splitBatches(script: string): string[] {
    return script
        .split(/^\s*GO\s*$/gim)
        .map((b) => b.trim())
        .filter((b) => b.length > 0);
}

async function deploy(filePath: string): Promise<void> {
    const abs = path.resolve(process.cwd(), filePath);
    if (!fs.existsSync(abs)) {
        throw new Error(`SQL script not found: ${abs}`);
    }
    const script = fs.readFileSync(abs, 'utf8');
    const batches = splitBatches(script);
    if (batches.length === 0) throw new Error('Empty script after splitting on GO.');

    const cfg = getListecPoolConfig();
    process.stdout.write(`Connecting to ${cfg.server} / ${cfg.database} as ${cfg.user}…\n`);
    const pool = await new sql.ConnectionPool(cfg).connect();
    try {
        let i = 0;
        for (const batch of batches) {
            i++;
            process.stdout.write(`  batch ${i}/${batches.length} (${batch.length} chars)…\n`);
            await pool.request().batch(batch);
        }
        process.stdout.write(`Deploy OK. Running smoke test…\n`);
        const today = new Date();
        const iso = today.toISOString().slice(0, 10);
        const r = await pool
            .request()
            .input('from_date', sql.Date, iso)
            .input('to_date', sql.Date, iso)
            .input('page', sql.Int, 1)
            .input('page_size', sql.Int, 5)
            .execute<Record<string, unknown>>('dbo.usp_listec_worksheet_report_json');
        const rows = r.recordsets[0] ?? [];
        process.stdout.write(`Smoke test returned ${rows.length} rows for ${iso}.\n`);
        const first = rows[0];
        if (first && typeof first.results_json === 'string') {
            try {
                const parsed = JSON.parse(first.results_json);
                process.stdout.write(`  results_json parsed (${Array.isArray(parsed) ? parsed.length : 'n/a'} entries).\n`);
            } catch (e) {
                process.stdout.write(`  results_json present but failed to JSON.parse: ${(e as Error).message}\n`);
            }
        }
    } finally {
        await pool.close();
    }
}

const target = process.argv[2];
if (!target) {
    process.stderr.write('Usage: ts-node scripts/deploy-sp.ts <path-to-sql-file>\n');
    process.exit(2);
}

deploy(target).catch((e) => {
    process.stderr.write(`Deploy failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
