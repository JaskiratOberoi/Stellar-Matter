'use strict';

/**
 * Tracer-only SQL source — issues ONE Listec call per BU instead of N (where
 * N today = 1 general + 5 specialty modes × per-mode test-code count). The
 * Listec service returns every SID for the window plus per-test-code SID
 * buckets (sidsByTestCode) when called with `bucketTestCodes=...`. We then
 * synthesise 6 mode-specific artefact pairs (general / urine_containers /
 * edta_vials / citrate_vials / s_heparin / l_heparin) per BU from that single
 * response, so the dashboard tile wall picks them up unchanged.
 *
 * For a 2-BU month run this collapses 30 SP executions on Noble down to 2.
 *
 * The dashboard's regular `/api/run` per-mode flow is untouched — this module
 * is only invoked from the new `/api/tracer-run` endpoint in server.js.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';

// Mirrors cli/lib/sql-source.js. Kept duplicated here intentionally so the
// Tracer pipeline can evolve its pinned-code lists independently of the
// per-mode dashboard runs (e.g. adding an exploratory test code for Tracer
// without affecting the audit-stable per-mode calls).
const URINE_CONTAINER_TEST_CODES = ['cp004', 'mb034'];
const EDTA_VIAL_TEST_CODES = ['he011', 'he022', 'he006', 'he055', 'bi127'];
const CITRATE_VIAL_TEST_CODES = ['he030', 'he004', 'he016', 'hem001'];
const S_HEPARIN_TEST_CODES = ['ky004', 'cp3257'];
const L_HEPARIN_TEST_CODES = ['ms091'];

const SPECIALTY_MODES = [
    { mode: 'urine_containers', codes: URINE_CONTAINER_TEST_CODES, blobKey: 'urineContainers' },
    { mode: 'edta_vials', codes: EDTA_VIAL_TEST_CODES, blobKey: 'edtaVials' },
    { mode: 'citrate_vials', codes: CITRATE_VIAL_TEST_CODES, blobKey: 'citrateVials' },
    { mode: 's_heparin', codes: S_HEPARIN_TEST_CODES, blobKey: 'sHeparin' },
    { mode: 'l_heparin', codes: L_HEPARIN_TEST_CODES, blobKey: 'lHeparin' }
];

// Union of every specialty code so we send one combined `bucketTestCodes`
// query string per BU. Listec's aggregator pre-seeds buckets for every code
// even when a code has zero hits, so the response shape is stable.
const ALL_SPECIALTY_CODES = [
    ...URINE_CONTAINER_TEST_CODES,
    ...EDTA_VIAL_TEST_CODES,
    ...CITRATE_VIAL_TEST_CODES,
    ...S_HEPARIN_TEST_CODES,
    ...L_HEPARIN_TEST_CODES
];

function trimOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

function toIsoDate(value) {
    const s = trimOrNull(value);
    if (!s) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = /^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/.exec(s);
    if (m) {
        const d = m[1].padStart(2, '0');
        const mo = m[2].padStart(2, '0');
        return `${m[3]}-${mo}-${d}`;
    }
    const t = new Date(s);
    if (!Number.isNaN(t.getTime())) return t.toISOString().slice(0, 10);
    return null;
}

/**
 * Build the Listec query string for a single tracer call. We always pass
 * `bucketTestCodes` so the response includes the SID buckets we need; we
 * never set `testCode` because that would re-narrow the SP and defeat the
 * whole optimisation.
 */
function buildQueryString({ bu, fromDate, toDate, fromHour, toHour, bucketCodes }) {
    const params = new URLSearchParams();
    const fromIso = toIsoDate(fromDate);
    const toIso = toIsoDate(toDate) || fromIso;
    if (!fromIso) {
        const today = new Date().toISOString().slice(0, 10);
        params.set('fromDate', today);
        params.set('toDate', today);
    } else {
        params.set('fromDate', fromIso);
        params.set('toDate', toIso || fromIso);
    }
    if (fromHour != null && String(fromHour).trim() !== '') params.set('fromHour', String(fromHour));
    if (toHour != null && String(toHour).trim() !== '') params.set('toHour', String(toHour));
    const buStr = trimOrNull(bu);
    if (buStr) {
        const buNum = Number(buStr);
        if (Number.isFinite(buNum) && /^\d+$/.test(buStr)) params.set('businessUnitId', buStr);
        else params.set('businessUnit', buStr);
    }
    if (bucketCodes && bucketCodes.length > 0) {
        params.set('bucketTestCodes', bucketCodes.join(','));
    }
    return params.toString();
}

/**
 * Bound-concurrency helper. We don't pull in p-limit — a 20-line semaphore
 * here is easier to audit than an external dep and matches the rest of this
 * codebase's "no-deps where possible" stance.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @param {number} concurrency
 * @returns {Promise<T[]>}
 */
async function runWithConcurrency(tasks, concurrency) {
    const cap = Math.max(1, Math.floor(concurrency || 1));
    const results = new Array(tasks.length);
    let nextIndex = 0;
    async function worker() {
        for (;;) {
            const i = nextIndex++;
            if (i >= tasks.length) return;
            results[i] = await tasks[i]();
        }
    }
    const workerCount = Math.min(cap, tasks.length);
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
}

/**
 * Build the on-disk artefact pair (main + packages) for one mode synthesised
 * from a single Listec response. Mirrors the shape that sql-source.js writes
 * so scripts/lis-nav-bot/server.js#buildTileFromRunFiles renders it without
 * changes and server/db/runs.js#projectRun can ingest it.
 *
 * @param {object} ctx - { mode, blobKey, codes, payload, bu, fromDate, toDate, fromHour, toHour, listecApiBase, requestUrl, startedAtIso, runId, orgId, outDir }
 * @returns {{ outMainPath: string, outPackagesPath: string, runId: string }}
 */
function writeModeArtefact(ctx) {
    const {
        mode,
        blobKey,
        codes,
        payload,
        bu,
        fromDate,
        toDate,
        fromHour,
        toHour,
        listecApiBase,
        requestUrl,
        startedAtIso,
        runId,
        orgId,
        outDir
    } = ctx;

    // Tracer always uses the FULL payload's labels for the general-mode tile
    // (Letter Heads / Envelopes / Other tests). Specialty tiles never read
    // labelOccurrences in the UI, but we still copy the same map across so a
    // future feature can read either tile interchangeably without a re-run.
    const labelOccurrences =
        payload.labelOccurrences && typeof payload.labelOccurrences === 'object' ? payload.labelOccurrences : {};
    const labelToSids =
        payload.labelToSids && typeof payload.labelToSids === 'object' ? payload.labelToSids : {};
    const rowCount = Number(payload.rowCount) || 0;
    const otherTestsRowCount = Number(payload.otherTestsRowCount) || 0;
    const rowsWithBrackets = Number(payload.rowsWithBrackets) || 0;
    const uniqueLabelCount =
        Number(payload.uniqueLabelCount) || Object.keys(labelOccurrences).length;

    let modeBlob = null;
    let sids;
    if (mode === 'general') {
        sids = Array.isArray(payload.sids) ? payload.sids : [];
    } else {
        // Specialty mode: derive byTestCode from the SID buckets and union
        // them so sidsTotal stays the unique-SID count (= tubes/containers
        // needed). This matches sql-source.js semantics 1-for-1.
        const sidsByCode =
            payload.sidsByTestCode && typeof payload.sidsByTestCode === 'object' ? payload.sidsByTestCode : {};
        const rowsByCode =
            payload.resultRowsByTestCode && typeof payload.resultRowsByTestCode === 'object'
                ? payload.resultRowsByTestCode
                : {};
        const byTestCode = {};
        const union = new Set();
        for (const code of codes) {
            const lower = String(code).toLowerCase();
            const codeSids = Array.isArray(sidsByCode[lower]) ? sidsByCode[lower] : [];
            const codeRows = Number(rowsByCode[lower]) || 0;
            byTestCode[code] = { sids: codeSids.length, rows: codeRows };
            for (const s of codeSids) union.add(String(s));
        }
        sids = [...union].sort();
        modeBlob = {
            sidsTotal: sids.length,
            testCodes: codes.slice(),
            byTestCode
        };
    }

    const filters = {
        bu: bu != null ? String(bu) : null,
        status: null,
        testCode: null,
        fromDate: fromDate || null,
        toDate: toDate || null,
        fromHour: fromHour ?? null,
        toHour: toHour ?? null,
        clientCode: null,
        sid: null,
        vailId: null,
        pid: null,
        deptNo: null
    };

    const filtersApplied = {
        query: requestUrl ? requestUrl.split('?')[1] || '' : '',
        notes: [`tracer-run: bucketed ${ALL_SPECIALTY_CODES.length} test code(s) from a single SP execution`],
        spFilters: payload.filters || null,
        resolved: payload.resolved || null
    };

    const main = {
        startedAt: startedAtIso,
        readOnly: true,
        source: 'sql',
        mode,
        testCodes: mode === 'general' ? null : codes.slice(),
        listecApiBase,
        primaryUrl: null,
        backupUrlUsed: false,
        filtersRequested: { ...filters },
        filtersApplied,
        dryRun: false,
        pager: { found: false, message: 'sql tracer source — single batched SP call' },
        sidsFoundOnPage1: sids,
        openedSid: null,
        scrapePackages: {
            enabled: true,
            source: 'sql-tracer',
            pagesScanned: 1,
            pageVisits: [
                { index: 1, pagerPage: 1, rowCount, rowsWithBracketLabels: rowsWithBrackets }
            ],
            rowCount,
            uniqueLabelCount,
            packagesJsonPath: null,
            labelOccurrences,
            otherTestsRowCount,
            recoveryEvents: [],
            completedPagerPages: [1],
            lastCompletedPagerPage: 1
        },
        errors: []
    };
    if (modeBlob) {
        main[blobKey] = modeBlob;
    }

    const packages = {
        startedAt: startedAtIso,
        source: 'sql-tracer',
        mode,
        testCodes: mode === 'general' ? null : codes.slice(),
        listecApiBase,
        filter: { ...filters },
        filtersApplied,
        pagesScanned: 1,
        pageVisits: main.scrapePackages.pageVisits,
        rowCount,
        uniqueLabelCount,
        labelToSids,
        labelOccurrences,
        otherTestsRowCount,
        urineContainers: mode === 'urine_containers' ? modeBlob : null,
        edtaVials: mode === 'edta_vials' ? modeBlob : null,
        citrateVials: mode === 'citrate_vials' ? modeBlob : null,
        sHeparin: mode === 's_heparin' ? modeBlob : null,
        lHeparin: mode === 'l_heparin' ? modeBlob : null,
        recoveryEvents: [],
        completedPagerPages: [1],
        lastCompletedPagerPage: 1,
        partial: false
    };

    fs.mkdirSync(outDir, { recursive: true });
    const outMainPath = path.join(outDir, `run-${runId}.json`);
    const outPackagesPath = path.join(outDir, `run-${runId}-packages.json`);
    main.scrapePackages.packagesJsonPath = outPackagesPath;

    fs.writeFileSync(outMainPath, JSON.stringify(Object.assign({ org_id: orgId }, main), null, 2), 'utf8');
    fs.writeFileSync(outPackagesPath, JSON.stringify(Object.assign({ org_id: orgId }, packages), null, 2), 'utf8');

    return { outMainPath, outPackagesPath, runId };
}

/**
 * Run one Tracer batch — N BUs × 6 modes derived from N Listec calls (one
 * per BU, fired with capped concurrency).
 *
 * @param {object} opts
 * @param {string[]} opts.businessUnits - resolved BU names/ids passed to Listec
 * @param {string} opts.fromDate
 * @param {string} opts.toDate
 * @param {number=} opts.fromHour
 * @param {number=} opts.toHour
 * @param {string} opts.orgId
 * @param {string} opts.outDir
 * @param {number=} opts.concurrency - default 3
 * @param {string=} opts.listecApiBase - default LISTEC_API_BASE_URL or 127.0.0.1:3100
 * @param {(item: { bu: string, state: 'queued'|'running'|'done'|'failed', runIds?: Record<string, string>, error?: string|null }) => void=} opts.onProgress
 *
 * @returns {Promise<{ items: Array<{ bu: string, state: string, runIds: Record<string,string>, error: string|null, lastOutMainPath: string|null, lastOutPackagesPath: string|null }>, completed: string[], failed: string[] }>}
 */
async function runTracerBatch(opts) {
    const businessUnits = Array.isArray(opts.businessUnits) ? opts.businessUnits.slice() : [];
    if (businessUnits.length === 0) {
        const err = new Error('runTracerBatch: businessUnits required');
        err.code = 'TRACER_NO_BUS';
        throw err;
    }

    const apiBase = (opts.listecApiBase || process.env.LISTEC_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, '');
    const orgId = opts.orgId || 'org-default';
    const outDir = path.isAbsolute(opts.outDir)
        ? opts.outDir
        : path.resolve(process.cwd(), opts.outDir || './out');
    const concurrency = opts.concurrency != null ? Number(opts.concurrency) : 3;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};

    /** @type {Array<{ bu: string, state: string, runIds: Record<string,string>, error: string|null, lastOutMainPath: string|null, lastOutPackagesPath: string|null }>} */
    const items = businessUnits.map((bu) => ({
        bu,
        state: 'queued',
        runIds: {},
        error: null,
        lastOutMainPath: null,
        lastOutPackagesPath: null
    }));

    for (const it of items) onProgress({ ...it });

    const tasks = businessUnits.map((bu, i) => async () => {
        const item = items[i];
        item.state = 'running';
        onProgress({ ...item });

        try {
            const qs = buildQueryString({
                bu,
                fromDate: opts.fromDate,
                toDate: opts.toDate,
                fromHour: opts.fromHour,
                toHour: opts.toHour,
                bucketCodes: ALL_SPECIALTY_CODES
            });
            const url = `${apiBase}/api/worksheet-reports/packages?${qs}`;
            console.log(`[tracer-sql] GET ${url}`);
            const r = await fetch(url, { headers: { Accept: 'application/json' } });
            const text = await r.text();
            if (!r.ok) {
                throw new Error(`Listec API ${r.status} for BU=${bu}: ${text.slice(0, 500)}`);
            }
            let payload;
            try {
                payload = JSON.parse(text);
            } catch (parseErr) {
                throw new Error(`Listec API returned non-JSON for BU=${bu}: ${parseErr.message}`);
            }

            // Defensive contract check — surface a clear error if Listec is
            // older than this lis-nav-bot. Without sidsByTestCode we cannot
            // bucket SIDs, so we'd silently produce empty specialty tiles.
            if (!payload || typeof payload.sidsByTestCode !== 'object') {
                throw new Error(
                    `Listec response missing sidsByTestCode for BU=${bu} — Listec service is older than lis-nav-bot. Restart the Listec service after deploying the bucketTestCodes change.`
                );
            }

            // Stamp 6 distinct ISO timestamps (1ms apart) so each mode gets a
            // unique slug. Sub-second offset keeps tile sort order intuitive
            // (general first, then urine, EDTA, citrate, S.Hep, L.Hep) within
            // the same BU's batch.
            const baseMs = Date.now();
            const modes = ['general', ...SPECIALTY_MODES.map((m) => m.mode)];
            const codesByMode = { general: null };
            const blobKeyByMode = { general: null };
            for (const m of SPECIALTY_MODES) {
                codesByMode[m.mode] = m.codes;
                blobKeyByMode[m.mode] = m.blobKey;
            }

            for (let mi = 0; mi < modes.length; mi++) {
                const mode = modes[mi];
                const startedAtIso = new Date(baseMs + mi).toISOString();
                const runId = startedAtIso.replace(/[:.]/g, '-');
                const written = writeModeArtefact({
                    mode,
                    blobKey: blobKeyByMode[mode],
                    codes: codesByMode[mode] || [],
                    payload,
                    bu,
                    fromDate: opts.fromDate,
                    toDate: opts.toDate,
                    fromHour: opts.fromHour,
                    toHour: opts.toHour,
                    listecApiBase: apiBase,
                    requestUrl: url,
                    startedAtIso,
                    runId,
                    orgId,
                    outDir
                });
                item.runIds[mode] = written.runId;
                item.lastOutMainPath = written.outMainPath;
                item.lastOutPackagesPath = written.outPackagesPath;
            }

            item.state = 'done';
            onProgress({ ...item });
            return item;
        } catch (e) {
            item.state = 'failed';
            item.error = String(e && e.message ? e.message : e);
            onProgress({ ...item });
            return item;
        }
    });

    await runWithConcurrency(tasks, concurrency);

    const completed = items.filter((it) => it.state === 'done').map((it) => it.bu);
    const failed = items.filter((it) => it.state === 'failed').map((it) => it.bu);
    return { items, completed, failed };
}

module.exports = {
    runTracerBatch,
    ALL_SPECIALTY_CODES,
    SPECIALTY_MODES,
    URINE_CONTAINER_TEST_CODES,
    EDTA_VIAL_TEST_CODES,
    CITRATE_VIAL_TEST_CODES,
    S_HEPARIN_TEST_CODES,
    L_HEPARIN_TEST_CODES
};
