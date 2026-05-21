'use strict';

/**
 * One-shot Tracer batch runner (no HTTP / JWT). Uses repo .env + ./out + Postgres.
 * Usage: node scripts/run-tracer-batch-cli.js ROHTAK AGRA --from 01/04/2026 --to 30/04/2026
 */

const path = require('node:path');
const { loadLisNavBotEnv } = require('../cli/lib/load-env');

loadLisNavBotEnv(path.join(__dirname, 'lis-nav-bot'));

const { runTracerBatch } = require('../cli/lib/sql-tracer-source');
const runsDb = require('../server/db/runs');

function parseArgs(argv) {
    const bus = [];
    let fromDate = null;
    let toDate = null;
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--from' && argv[i + 1]) {
            fromDate = argv[++i];
            continue;
        }
        if (a === '--to' && argv[i + 1]) {
            toDate = argv[++i];
            continue;
        }
        if (!a.startsWith('-')) bus.push(a);
    }
    return { bus, fromDate, toDate };
}

async function main() {
    const { bus, fromDate, toDate } = parseArgs(process.argv);
    if (!bus.length || !fromDate || !toDate) {
        console.error(
            'Usage: node scripts/run-tracer-batch-cli.js <BU> [BU2 ...] --from DD/MM/YYYY --to DD/MM/YYYY'
        );
        process.exit(1);
    }

    const outDir = process.env.LIS_OUT_DIR
        ? path.resolve(process.env.LIS_OUT_DIR)
        : path.resolve(__dirname, '..', 'out');
    let listecBase = process.env.LISTEC_API_BASE_URL || 'http://127.0.0.1:3100';
    if (/host\.docker\.internal/i.test(listecBase)) {
        listecBase = 'http://127.0.0.1:3100';
    }
    const listecApiBase = listecBase.replace(/\/$/, '');
    const orgId = 'org-default';

    console.log('[tracer-cli] BUs:', bus.join(', '));
    console.log('[tracer-cli] window:', fromDate, '→', toDate);
    console.log('[tracer-cli] outDir:', outDir);
    console.log('[tracer-cli] listec:', listecApiBase);

    const result = await runTracerBatch({
        businessUnits: bus,
        fromDate,
        toDate,
        orgId,
        outDir,
        concurrency: 2,
        listecApiBase,
        onProgress: (snap) => {
            console.log(`[tracer-cli] ${snap.bu}: ${snap.state}${snap.error ? ` — ${snap.error}` : ''}`);
        }
    });

    const allWrites = [...result.items, ...result.regionItems, ...(result.collatedItems || [])];
    let ingested = 0;
    for (const it of allWrites) {
        if (it.state !== 'done') {
            console.warn(`[tracer-cli] ${it.bu}: failed — ${it.error || 'unknown'}`);
            continue;
        }
        const modes = Object.keys(it.runIds || {});
        for (const cid of Object.values(it.runIds || {})) {
            if (!cid) continue;
            const r = await runsDb.ingestRunSafe(outDir, cid);
            if (r && r.ingested) ingested++;
        }
        console.log(`[tracer-cli] ${it.bu}: done (${modes.length} mode artefacts)`);
    }

    console.log(`[tracer-cli] complete — ingested ${ingested} run row(s) into Postgres`);
    const failed = allWrites.filter((it) => it.state !== 'done');
    process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
    console.error('[tracer-cli] fatal:', e && e.message ? e.message : e);
    process.exit(1);
});
