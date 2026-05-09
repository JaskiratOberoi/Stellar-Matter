'use strict';

/**
 * SQL data source — fetches sample worksheet data directly from the Listec
 * mssql HTTP service (Listec/integration/node-mssql) instead of scraping
 * the LIS web UI. Produces the same result/artifact shape as the scrape
 * path so server.js / public/app.js dashboard work unchanged.
 *
 * Entry point: runViaSql(programOpts).
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_API_BASE = 'http://127.0.0.1:3100';

// Urine-container counting auto-pins these test codes. The Listec stored
// procedure (Listec/sp/usp_listec_worksheet_report_json.sql) takes a single
// @test_code, so to OR them together we make N parallel HTTP calls — one per
// code — and union the SID sets in JS. A patient who ordered both tests still
// counts as one container (one urine sample, two assays).
const URINE_CONTAINER_TEST_CODES = ['cp004', 'mb034'];

// EDTA vial tallies — same N-parallel + SID union pattern as urine containers.
const EDTA_VIAL_TEST_CODES = ['he011', 'he022', 'he006', 'he055', 'bi127'];

// Citrate vials — same multi-call + SID union as EDTA.
const CITRATE_VIAL_TEST_CODES = ['he030', 'he004', 'he016', 'hem001'];

// Sodium-heparin (S.Heparin) tubes — same multi-call + SID union pattern.
const S_HEPARIN_TEST_CODES = ['ky004', 'cp3257'];

// Lithium-heparin (L.Heparin) tubes — currently a single test code, but still
// runs through the multi-call/union pipeline so future expansion (extra assays
// sharing the same tube) is a one-line array edit and still SID-dedupes.
const L_HEPARIN_TEST_CODES = ['ms091'];

/**
 * Merge N Listec /worksheet-reports/packages payloads into a single
 * payload-equivalent so the rest of runViaSql doesn't need to care that we
 * fired multiple calls. Used by urine-container mode.
 *
 * Merge rules:
 *   sids                 — set union (a SID present in either call counts once)
 *   labelOccurrences     — per-label SUM across calls; the same SID counted
 *                          twice (once per testCode) is fine here because
 *                          labels track package occurrences, not patients.
 *   labelToSids          — per-label set union of SIDs
 *   rowCount             — SUM (these are physical rows; not deduplicated)
 *   otherTestsRowCount   — SUM
 *   uniqueLabelCount     — recomputed from merged labelOccurrences
 *   resolved/spFilters   — taken from the first non-empty payload
 *   unresolved           — concatenated, deduplicated
 *
 * @param {object[]} payloads
 * @returns {object}
 */
function mergePayloads(payloads) {
    const sidUnion = new Set();
    /** @type {Record<string, number>} */
    const labelOccurrences = {};
    /** @type {Record<string, Set<string>>} */
    const labelToSidSets = {};
    let rowCount = 0;
    let otherTestsRowCount = 0;
    let rowsWithBrackets = 0;
    let resolved = null;
    let spFilters = null;
    const unresolved = new Set();

    for (const p of payloads) {
        if (!p || typeof p !== 'object') continue;

        if (Array.isArray(p.sids)) for (const s of p.sids) sidUnion.add(String(s));

        if (p.labelOccurrences && typeof p.labelOccurrences === 'object') {
            for (const [label, n] of Object.entries(p.labelOccurrences)) {
                labelOccurrences[label] = (labelOccurrences[label] || 0) + (Number(n) || 0);
            }
        }
        if (p.labelToSids && typeof p.labelToSids === 'object') {
            for (const [label, sids] of Object.entries(p.labelToSids)) {
                if (!labelToSidSets[label]) labelToSidSets[label] = new Set();
                if (Array.isArray(sids)) for (const s of sids) labelToSidSets[label].add(String(s));
            }
        }
        rowCount += Number(p.rowCount) || 0;
        otherTestsRowCount += Number(p.otherTestsRowCount) || 0;
        rowsWithBrackets += Number(p.rowsWithBrackets) || 0;
        if (resolved == null && p.resolved && typeof p.resolved === 'object') resolved = p.resolved;
        if (spFilters == null && p.filters && typeof p.filters === 'object') spFilters = p.filters;
        if (Array.isArray(p.unresolved)) for (const u of p.unresolved) unresolved.add(String(u));
    }

    const labelToSids = {};
    for (const [label, set] of Object.entries(labelToSidSets)) {
        labelToSids[label] = [...set];
    }

    return {
        sids: [...sidUnion],
        labelOccurrences,
        labelToSids,
        rowCount,
        otherTestsRowCount,
        rowsWithBrackets,
        uniqueLabelCount: Object.keys(labelOccurrences).length,
        resolved,
        filters: spFilters,
        unresolved: [...unresolved]
    };
}

/** @param {string} v */
function trimOrNull(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

/** Convert DD/MM/YYYY (or DD-MM-YYYY) to YYYY-MM-DD; pass through if already ISO. */
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

function toIntOrNull(v) {
    if (v == null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Map lis-nav-bot UI/CLI filters → query string for the Listec service.
 * String-valued filters that the SP expects as numeric IDs (bu / status /
 * deptNo) are passed only when numeric; otherwise we record an info note.
 */
function buildQueryString(filters, notes) {
    const params = new URLSearchParams();

    const fromIso = toIsoDate(filters.fromDate);
    const toIso = toIsoDate(filters.toDate) || fromIso;
    if (!fromIso) {
        const today = new Date().toISOString().slice(0, 10);
        params.set('fromDate', today);
        params.set('toDate', today);
        notes.push('No fromDate supplied — defaulted to today.');
    } else {
        params.set('fromDate', fromIso);
        params.set('toDate', toIso || fromIso);
    }

    if (filters.fromHour != null) params.set('fromHour', String(filters.fromHour));
    if (filters.toHour != null) params.set('toHour', String(filters.toHour));

    const buNum = toIntOrNull(filters.bu);
    if (buNum != null) params.set('businessUnitId', String(buNum));
    else if (trimOrNull(filters.bu)) params.set('businessUnit', trimOrNull(filters.bu));

    const statusNum = toIntOrNull(filters.status);
    if (statusNum != null) params.set('statusId', String(statusNum));
    else if (trimOrNull(filters.status)) params.set('status', trimOrNull(filters.status));

    const deptNum = toIntOrNull(filters.deptNo);
    if (deptNum != null) params.set('departmentId', String(deptNum));
    else if (trimOrNull(filters.deptNo)) params.set('dept', trimOrNull(filters.deptNo));

    const testCode = trimOrNull(filters.testCode);
    if (testCode) params.set('testCode', testCode);

    const clientCode = trimOrNull(filters.clientCode);
    if (clientCode) params.set('clientCode', clientCode);

    const sid = trimOrNull(filters.sid) || trimOrNull(filters.vailId);
    if (sid) params.set('sid', sid);

    const pid = toIntOrNull(filters.pid);
    if (pid != null) params.set('pid', String(pid));

    return params.toString();
}

/**
 * @param {object} programOpts - same shape as Puppeteer runner accepts
 * @returns {Promise<{ result: object, outMainPath: string|null, outPackagesPath: string|null, exitCode: number }>}
 */
async function runViaSql(programOpts) {
    const opts = programOpts || {};

    if (process.env.LIS_ALLOW_WRITES === '1') {
        const err = new Error('LIS_ALLOW_WRITES=1 — read-only refusal.');
        err.code = 'LIS_ALLOW_WRITES';
        throw err;
    }

    const apiBase =
        (process.env.LISTEC_API_BASE_URL && process.env.LISTEC_API_BASE_URL.trim()) || DEFAULT_API_BASE;
    const apiBaseClean = apiBase.replace(/\/$/, '');

    const startedAt =
        opts.startedAt && !Number.isNaN(new Date(opts.startedAt).getTime())
            ? new Date(opts.startedAt).toISOString()
            : new Date().toISOString();
    const stamp = startedAt.replace(/[:.]/g, '-');

    const filters = {
        bu: opts.bu ?? process.env.LIS_BU,
        status: opts.status ?? process.env.LIS_STATUS,
        testCode: opts.testCode ?? process.env.LIS_TEST_CODE,
        fromDate: opts.fromDate ?? process.env.LIS_FROM_DATE,
        toDate: opts.toDate ?? process.env.LIS_TO_DATE,
        fromHour: opts.fromHour ?? process.env.LIS_FROM_HOUR,
        toHour: opts.toHour ?? process.env.LIS_TO_HOUR,
        clientCode: opts.clientCode ?? process.env.LIS_CLIENT_CODE,
        sid: opts.sid ?? process.env.LIS_SID,
        vailId: opts.vailId ?? process.env.LIS_VAIL_ID,
        pid: opts.pid ?? process.env.LIS_PID,
        deptNo: opts.deptNo ?? process.env.LIS_DEPT_NO,
    };

    const dryRun =
        !!opts.dryRun ||
        String(process.env.LIS_DRY_RUN || '').trim() === '1' ||
        String(process.env.LIS_DRY_RUN || '').toLowerCase() === 'true';

    const orgId = opts.orgId != null ? String(opts.orgId) : process.env.LIS_ORG_ID || 'org-default';
    const outDirRaw = opts.outDir != null ? opts.outDir : process.env.LIS_OUT_DIR || './out';
    const outDir = path.isAbsolute(String(outDirRaw))
        ? String(outDirRaw)
        : path.resolve(process.cwd(), String(outDirRaw));

    // Mode resolution: specialty modes pin N test codes and union SIDs; general
    // uses a single call (optional testCode filter).
    const rawMode = opts.mode != null ? String(opts.mode) : '';
    let mode = 'general';
    if (rawMode === 'urine_containers') mode = 'urine_containers';
    else if (rawMode === 'edta_vials') mode = 'edta_vials';
    else if (rawMode === 'citrate_vials') mode = 'citrate_vials';
    else if (rawMode === 's_heparin') mode = 's_heparin';
    else if (rawMode === 'l_heparin') mode = 'l_heparin';

    let testCodesToRun;
    if (mode === 'urine_containers') testCodesToRun = URINE_CONTAINER_TEST_CODES.slice();
    else if (mode === 'edta_vials') testCodesToRun = EDTA_VIAL_TEST_CODES.slice();
    else if (mode === 'citrate_vials') testCodesToRun = CITRATE_VIAL_TEST_CODES.slice();
    else if (mode === 's_heparin') testCodesToRun = S_HEPARIN_TEST_CODES.slice();
    else if (mode === 'l_heparin') testCodesToRun = L_HEPARIN_TEST_CODES.slice();
    else testCodesToRun = [filters.testCode || null]; // null = no testCode filter

    /** @type {string[]} */
    const notes = [];
    // For the legacy single-call path qs is the literal query string we sent.
    // For multi-call (urine) we keep an array so the artefact can show every URL.
    const qsList = testCodesToRun.map((code) =>
        buildQueryString({ ...filters, testCode: code != null ? code : filters.testCode }, notes)
    );
    const qs = qsList.length === 1 ? qsList[0] : qsList;

    /** @type {object} */
    const pinnedCodes =
        mode === 'urine_containers'
            ? URINE_CONTAINER_TEST_CODES.slice()
            : mode === 'edta_vials'
              ? EDTA_VIAL_TEST_CODES.slice()
              : mode === 'citrate_vials'
                ? CITRATE_VIAL_TEST_CODES.slice()
                : mode === 's_heparin'
                  ? S_HEPARIN_TEST_CODES.slice()
                  : mode === 'l_heparin'
                    ? L_HEPARIN_TEST_CODES.slice()
                    : null;

    const result = {
        startedAt,
        readOnly: true,
        source: 'sql',
        mode,
        testCodes: pinnedCodes,
        listecApiBase: apiBaseClean,
        primaryUrl: null,
        backupUrlUsed: false,
        filtersRequested: { ...filters },
        filtersApplied: { query: qs, notes },
        dryRun,
        pager: null,
        sidsFoundOnPage1: [],
        openedSid: null,
        scrapePackages: { enabled: false },
        errors: [],
    };
    let outMainPath = null;
    let outPackagesPath = null;
    let exitCode = 0;

    if (dryRun) {
        const dryUrls = qsList.map((q) => `GET ${apiBaseClean}/api/worksheet-reports/packages?${q}`);
        const multiLabel =
            mode === 'urine_containers'
                ? 'urine container OR-union'
                : mode === 'edta_vials'
                  ? 'EDTA vial OR-union'
                  : mode === 'citrate_vials'
                    ? 'Citrate vial OR-union'
                    : mode === 's_heparin'
                      ? 'S.Heparin OR-union'
                      : mode === 'l_heparin'
                        ? 'L.Heparin OR-union'
                        : 'multi-code';
        result.message =
            qsList.length === 1
                ? `dry-run: would call ${dryUrls[0]}`
                : `dry-run: would call ${qsList.length} Listec endpoints (${multiLabel}):\n  ${dryUrls.join('\n  ')}`;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            outMainPath = path.join(outDir, `run-${stamp}.json`);
            fs.writeFileSync(outMainPath, JSON.stringify(Object.assign({ org_id: orgId }, result), null, 2), 'utf8');
            console.log(`[sql] dry-run wrote ${outMainPath}`);
        } catch (e) {
            result.errors.push(`dry-run write: ${e.message}`);
            exitCode = 1;
        }
        return { result, outMainPath, outPackagesPath, exitCode };
    }

    // Fetch all codes in parallel. For mode=general this is just one call,
    // matching the legacy behaviour. For urine_containers it's one per code.
    /** @type {Array<{ code: string|null, payload: any, qs: string, url: string }>} */
    let perCallResults;
    try {
        perCallResults = await Promise.all(
            testCodesToRun.map(async (code, i) => {
                const callQs = qsList[i];
                const url = `${apiBaseClean}/api/worksheet-reports/packages?${callQs}`;
                console.log(`[sql] GET ${url}`);
                const r = await fetch(url, { headers: { Accept: 'application/json' } });
                const text = await r.text();
                if (!r.ok) {
                    throw new Error(`Listec API ${r.status} for testCode=${code || '(none)'}: ${text.slice(0, 500)}`);
                }
                let p;
                try {
                    p = JSON.parse(text);
                } catch (parseErr) {
                    throw new Error(`Listec API returned non-JSON for testCode=${code || '(none)'}: ${parseErr.message}`);
                }
                return { code, payload: p, qs: callQs, url };
            })
        );
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        result.errors.push(`Listec API call failed: ${msg}`);
        exitCode = 1;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            outMainPath = path.join(outDir, `run-${stamp}-error.json`);
            fs.writeFileSync(outMainPath, JSON.stringify(Object.assign({ org_id: orgId }, result), null, 2), 'utf8');
        } catch (_) {}
        return { result, outMainPath, outPackagesPath, exitCode };
    }

    // Collapse per-call payloads into a single payload-equivalent for the
    // existing artefact-write path. Single-call (general mode) is a pass-through.
    const payload =
        perCallResults.length === 1 ? perCallResults[0].payload : mergePayloads(perCallResults.map((r) => r.payload));

    if (payload.resolved && typeof payload.resolved === 'object') {
        result.filtersApplied.resolved = payload.resolved;
        for (const [key, info] of Object.entries(payload.resolved)) {
            if (info && info.id == null) {
                notes.push(`SQL source: ${key} "${info.input}" did not match any master row — filter ignored.`);
            }
        }
    }
    if (Array.isArray(payload.unresolved) && payload.unresolved.length) {
        for (const msg of payload.unresolved) notes.push(`SQL source: ${msg}`);
    }
    if (payload.filters && typeof payload.filters === 'object') {
        result.filtersApplied.spFilters = payload.filters;
    }

    const sids = Array.isArray(payload.sids) ? payload.sids : [];
    const labelOccurrences =
        payload.labelOccurrences && typeof payload.labelOccurrences === 'object'
            ? payload.labelOccurrences
            : {};
    const labelToSids =
        payload.labelToSids && typeof payload.labelToSids === 'object' ? payload.labelToSids : {};
    const rowCount = Number(payload.rowCount) || 0;
    const uniqueLabelCount = Number(payload.uniqueLabelCount) || Object.keys(labelOccurrences).length;
    const otherTestsRowCount = Number(payload.otherTestsRowCount) || 0;

    // Stamp urine-container metrics onto the result for the tile/modal renderer.
    // sidsTotal is the union count = unique containers needed (1 sample per patient).
    if (mode === 'urine_containers') {
        const byTestCode = {};
        for (const { code, payload: p } of perCallResults) {
            if (!code) continue;
            byTestCode[code] = {
                sids: Array.isArray(p.sids) ? p.sids.length : 0,
                rows: Number(p.rowCount) || 0
            };
        }
        result.urineContainers = {
            sidsTotal: sids.length,
            testCodes: URINE_CONTAINER_TEST_CODES.slice(),
            byTestCode
        };
    }
    if (mode === 'edta_vials') {
        const byTestCode = {};
        for (const { code, payload: p } of perCallResults) {
            if (!code) continue;
            byTestCode[code] = {
                sids: Array.isArray(p.sids) ? p.sids.length : 0,
                rows: Number(p.rowCount) || 0
            };
        }
        result.edtaVials = {
            sidsTotal: sids.length,
            testCodes: EDTA_VIAL_TEST_CODES.slice(),
            byTestCode
        };
    }
    if (mode === 'citrate_vials') {
        const byTestCode = {};
        for (const { code, payload: p } of perCallResults) {
            if (!code) continue;
            byTestCode[code] = {
                sids: Array.isArray(p.sids) ? p.sids.length : 0,
                rows: Number(p.rowCount) || 0
            };
        }
        result.citrateVials = {
            sidsTotal: sids.length,
            testCodes: CITRATE_VIAL_TEST_CODES.slice(),
            byTestCode
        };
    }
    if (mode === 's_heparin') {
        const byTestCode = {};
        for (const { code, payload: p } of perCallResults) {
            if (!code) continue;
            byTestCode[code] = {
                sids: Array.isArray(p.sids) ? p.sids.length : 0,
                rows: Number(p.rowCount) || 0
            };
        }
        result.sHeparin = {
            sidsTotal: sids.length,
            testCodes: S_HEPARIN_TEST_CODES.slice(),
            byTestCode
        };
    }
    if (mode === 'l_heparin') {
        const byTestCode = {};
        for (const { code, payload: p } of perCallResults) {
            if (!code) continue;
            byTestCode[code] = {
                sids: Array.isArray(p.sids) ? p.sids.length : 0,
                rows: Number(p.rowCount) || 0
            };
        }
        result.lHeparin = {
            sidsTotal: sids.length,
            testCodes: L_HEPARIN_TEST_CODES.slice(),
            byTestCode
        };
    }

    result.sidsFoundOnPage1 = sids;
    result.pager = { found: false, message: 'sql source — single batch, no grid pager' };
    result.scrapePackages = {
        enabled: true,
        source: 'sql',
        pagesScanned: 1,
        pageVisits: [
            {
                index: 1,
                pagerPage: 1,
                rowCount,
                rowsWithBracketLabels: Number(payload.rowsWithBrackets) || 0,
            },
        ],
        rowCount,
        uniqueLabelCount,
        packagesJsonPath: null,
        labelOccurrences,
        otherTestsRowCount,
        recoveryEvents: [],
        completedPagerPages: [1],
        lastCompletedPagerPage: 1,
    };

    try {
        fs.mkdirSync(outDir, { recursive: true });
        const pkgFile = path.join(outDir, `run-${stamp}-packages.json`);
        const packagesPayload = {
            startedAt,
            source: 'sql',
            mode,
            testCodes: pinnedCodes,
            listecApiBase: apiBaseClean,
            filter: { ...filters },
            filtersApplied: result.filtersApplied,
            pagesScanned: 1,
            pageVisits: result.scrapePackages.pageVisits,
            rowCount,
            uniqueLabelCount,
            labelToSids,
            labelOccurrences,
            otherTestsRowCount,
            urineContainers: result.urineContainers || null,
            edtaVials: result.edtaVials || null,
            citrateVials: result.citrateVials || null,
            sHeparin: result.sHeparin || null,
            lHeparin: result.lHeparin || null,
            recoveryEvents: [],
            completedPagerPages: [1],
            lastCompletedPagerPage: 1,
            partial: false,
        };
        fs.writeFileSync(pkgFile, JSON.stringify(Object.assign({ org_id: orgId }, packagesPayload), null, 2), 'utf8');
        outPackagesPath = pkgFile;
        result.scrapePackages.packagesJsonPath = pkgFile;
        console.log(`[sql] wrote ${pkgFile}`);

        const outFile = path.join(outDir, `run-${stamp}.json`);
        fs.writeFileSync(outFile, JSON.stringify(Object.assign({ org_id: orgId }, result), null, 2), 'utf8');
        outMainPath = outFile;
        console.log(`[sql] wrote ${outFile}`);
        const modeNote =
            mode === 'urine_containers'
                ? ` [urine: ${result.urineContainers.sidsTotal} container(s) from ${URINE_CONTAINER_TEST_CODES.join('+')}]`
                : mode === 'edta_vials'
                  ? ` [edta: ${result.edtaVials.sidsTotal} vial(s) from ${EDTA_VIAL_TEST_CODES.join('+')}]`
                  : mode === 'citrate_vials'
                    ? ` [citrate: ${result.citrateVials.sidsTotal} vial(s) from ${CITRATE_VIAL_TEST_CODES.join('+')}]`
                    : mode === 's_heparin'
                      ? ` [s.heparin: ${result.sHeparin.sidsTotal} tube(s) from ${S_HEPARIN_TEST_CODES.join('+')}]`
                      : mode === 'l_heparin'
                        ? ` [l.heparin: ${result.lHeparin.sidsTotal} tube(s) from ${L_HEPARIN_TEST_CODES.join('+')}]`
                        : '';
        console.log(
            `[sql] ${rowCount} row(s), ${sids.length} SID(s), ${uniqueLabelCount} unique label(s), ${otherTestsRowCount} Other tests row(s).${modeNote}`
        );
    } catch (e) {
        result.errors.push(`SQL write: ${e.message}`);
        exitCode = 1;
    }

    return { result, outMainPath, outPackagesPath, exitCode };
}

module.exports = { runViaSql };
