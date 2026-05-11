/**
 * Deploy SQL artefacts against the Noble database using the same connection
 * settings as the runtime client.
 *
 * Usage:
 *   # Single file (legacy):
 *   npx ts-node scripts/deploy-sp.ts ../../sp/usp_listec_worksheet_report_json.sql
 *
 *   # Walk every *.sql under Listec/integration/node-mssql/sql/ (lexical
 *   # order — prefix files with 01_, 02_, ... when ordering matters):
 *   npx ts-node scripts/deploy-sp.ts
 *   npx ts-node scripts/deploy-sp.ts --dir ./sql
 *
 * After deploy, runs a 1-row smoke test against
 * dbo.usp_listec_worksheet_report_json so we know the legacy SP is still
 * callable. Single-file deploys also smoke-test the legacy SP for parity.
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

async function deployBatches(pool: sql.ConnectionPool, label: string, script: string): Promise<void> {
    const batches = splitBatches(script);
    if (batches.length === 0) {
        process.stdout.write(`  ${label}: no batches after GO split, skipping.\n`);
        return;
    }
    let i = 0;
    for (const batch of batches) {
        i++;
        process.stdout.write(`  ${label} batch ${i}/${batches.length} (${batch.length} chars)…\n`);
        await pool.request().batch(batch);
    }
}

async function smokeTestLegacySp(pool: sql.ConnectionPool): Promise<void> {
    process.stdout.write(`Smoke-testing dbo.usp_listec_worksheet_report_json…\n`);
    const iso = new Date().toISOString().slice(0, 10);
    const r = await pool
        .request()
        .input('from_date', sql.Date, iso)
        .input('to_date', sql.Date, iso)
        .input('page', sql.Int, 1)
        .input('page_size', sql.Int, 5)
        .execute<Record<string, unknown>>('dbo.usp_listec_worksheet_report_json');
    const rows = r.recordsets[0] ?? [];
    process.stdout.write(`  returned ${rows.length} rows for ${iso}.\n`);
    const first = rows[0];
    if (first && typeof first.results_json === 'string') {
        try {
            const parsed = JSON.parse(first.results_json);
            process.stdout.write(`  results_json parsed (${Array.isArray(parsed) ? parsed.length : 'n/a'} entries).\n`);
        } catch (e) {
            process.stdout.write(`  results_json present but failed to JSON.parse: ${(e as Error).message}\n`);
        }
    }
}

async function deployFile(pool: sql.ConnectionPool, abs: string): Promise<void> {
    if (!fs.existsSync(abs)) {
        throw new Error(`SQL script not found: ${abs}`);
    }
    const script = fs.readFileSync(abs, 'utf8');
    await deployBatches(pool, path.basename(abs), script);
}

async function deployDir(pool: sql.ConnectionPool, dir: string): Promise<number> {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
        throw new Error(`SQL directory not found: ${dir}`);
    }
    const files = fs
        .readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.sql'))
        .sort();
    if (files.length === 0) {
        process.stdout.write(`No *.sql files in ${dir}.\n`);
        return 0;
    }
    process.stdout.write(`Deploying ${files.length} script(s) from ${dir}:\n`);
    for (const f of files) {
        await deployFile(pool, path.join(dir, f));
    }
    return files.length;
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    let dirMode = false;
    let dirPath = path.resolve(__dirname, '..', 'sql');
    let singleFile: string | null = null;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dir') {
            dirMode = true;
            const next = argv[i + 1];
            if (next && !next.startsWith('-')) {
                dirPath = path.resolve(process.cwd(), next);
                i++;
            }
        } else if (a === '--help' || a === '-h') {
            process.stdout.write(
                'Usage:\n  ts-node scripts/deploy-sp.ts                        # walk default sql/ dir\n  ts-node scripts/deploy-sp.ts --dir ./sql            # walk a specific dir\n  ts-node scripts/deploy-sp.ts <path-to-sql-file>     # single file (legacy)\n',
            );
            process.exit(0);
        } else if (!a.startsWith('-')) {
            singleFile = path.resolve(process.cwd(), a);
        }
    }

    if (!singleFile && !dirMode && fs.existsSync(dirPath)) {
        // Default: walk sql/ if it exists. Keeps `npm run deploy:sp` ergonomic
        // now that we've split SP + TVP into separate ordered files.
        dirMode = true;
    }

    const cfg = getListecPoolConfig();
    process.stdout.write(`Connecting to ${cfg.server} / ${cfg.database} as ${cfg.user}…\n`);
    const pool = await new sql.ConnectionPool(cfg).connect();
    try {
        if (dirMode) {
            await deployDir(pool, dirPath);
        } else if (singleFile) {
            await deployFile(pool, singleFile);
        } else {
            throw new Error(
                'No deploy target. Provide a file path or ensure sql/ exists for directory walk.',
            );
        }
        process.stdout.write(`Deploy OK.\n`);
        await smokeTestLegacySp(pool);
    } finally {
        await pool.close();
    }
}

main().catch((e) => {
    process.stderr.write(`Deploy failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
