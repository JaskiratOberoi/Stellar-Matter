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

const BRACKET_RE = /\[([^\]]+)\]/g;

function normaliseLabelBracket(raw) {
    return raw.replace(/\s+/g, ' ').trim();
}

function aggregateBracketsFromPackageRows(sliceRows) {
    const rows = Array.isArray(sliceRows) ? sliceRows : [];
    const labelOccurrences = {};
    const labelToSidSets = {};
    const sidSet = new Set();
    let rowsWithBrackets = 0;
    let otherTestsRowCount = 0;
    /** @type {{ sid: string, testNamesText: string }[]} */
    const rowsOut = [];

    for (const row of rows) {
        const sid = String(row.sid ?? '').trim();
        const text = row.testNamesText ?? '';
        rowsOut.push({ sid, testNamesText: text });
        if (sid) sidSet.add(sid);
        BRACKET_RE.lastIndex = 0;
        const counts = {};
        let m;
        while ((m = BRACKET_RE.exec(text)) !== null) {
            const label = normaliseLabelBracket(m[1] ?? '');
            if (!label) continue;
            counts[label] = (counts[label] ?? 0) + 1;
        }
        const labels = Object.keys(counts);
        if (labels.length === 0) {
            otherTestsRowCount++;
            continue;
        }
        rowsWithBrackets++;
        for (const [label, c] of Object.entries(counts)) {
            labelOccurrences[label] = (labelOccurrences[label] || 0) + c;
        }
        if (!sid) continue;
        const seenLbl = new Set();
        BRACKET_RE.lastIndex = 0;
        while ((m = BRACKET_RE.exec(text)) !== null) {
            const label = normaliseLabelBracket(m[1] ?? '');
            if (!label || seenLbl.has(label)) continue;
            seenLbl.add(label);
            if (!labelToSidSets[label]) labelToSidSets[label] = new Set();
            labelToSidSets[label].add(sid);
        }
    }

    const labelToSids = {};
    for (const [lbl, set] of Object.entries(labelToSidSets)) {
        labelToSids[lbl] = [...set].sort();
    }

    return {
        labelOccurrences,
        labelToSids,
        rowCount: rows.length,
        otherTestsRowCount,
        rowsWithBrackets,
        uniqueLabelCount: Object.keys(labelOccurrences).length,
        sids: [...sidSet].sort(),
        rows: rowsOut
    };
}

/** @param {object} payload */
function sidSetFromRegionBucket(payload, kind, regionKey) {
    const k = String(regionKey || '')
        .trim()
        .toUpperCase();
    if (!k) return new Set();
    if (kind === 'city')
        return new Set(Array.isArray(payload?.sidsByCity?.[k]) ? payload.sidsByCity[k].map(String) : []);
    return new Set(Array.isArray(payload?.sidsByState?.[k]) ? payload.sidsByState[k].map(String) : []);
}

/**
 * @param {object[]} listOfPayloads - one or many Listec `/packages` JSON bodies from the same date window (per-BU slices or global).
 * @param {'city'|'state'} kind
 * @param {string} regionKey - upper/normalised bucket key from `/api/regions`
 */
function buildSyntheticRegionalPayload(listOfPayloads, kind, regionKey) {
    const payloads = Array.isArray(listOfPayloads) ? listOfPayloads.filter(Boolean) : [];
    const mergedSliceRows = [];
    for (const p of payloads) {
        const allow = sidSetFromRegionBucket(p, kind, regionKey);
        for (const row of Array.isArray(p.rows) ? p.rows : []) {
            const sid = String(row.sid ?? '').trim();
            if (!sid || !allow.has(sid)) continue;
            mergedSliceRows.push(row);
        }
    }
    const bracket = aggregateBracketsFromPackageRows(mergedSliceRows);
    /** @type {Record<string,string[]>} */
    const sidsByTestCode = {};
    /** @type {Record<string,number>} */
    const resultRowsByTestCode = {};
    for (const code of ALL_SPECIALTY_CODES) {
        const lc = code.toLowerCase();
        const u = new Set();
        let rowPart = 0;
        for (const p of payloads) {
            const reg = sidSetFromRegionBucket(p, kind, regionKey);
            const arr = Array.isArray(p?.sidsByTestCode?.[lc]) ? p.sidsByTestCode[lc].map(String) : [];
            const hit = arr.filter((sid) => reg.has(String(sid).trim()));
            for (const sid of hit) u.add(String(sid).trim());
            const fullLen = arr.length;
            rowPart += fullLen
                ? Math.round((((p.resultRowsByTestCode && p.resultRowsByTestCode[lc]) || 0) * hit.length) / fullLen)
                : 0;
        }
        sidsByTestCode[lc] = [...u].sort();
        resultRowsByTestCode[lc] = rowPart;
    }
    return {
        ...bracket,
        sidsByTestCode,
        resultRowsByTestCode,
        filters: payloads[0]?.filters || null,
        resolved: payloads[0]?.resolved || null,
        rows: bracket.rows
    };
}

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
function buildQueryString({ bu, fromDate, toDate, fromHour, toHour, bucketCodes, bucketCityKeys, bucketStateKeys }) {
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
    const cityCsv = bucketCityKeys && bucketCityKeys.length ? bucketCityKeys.join(',') : '';
    const stateCsv = bucketStateKeys && bucketStateKeys.length ? bucketStateKeys.join(',') : '';
    if (cityCsv) params.set('bucketCities', cityCsv);
    if (stateCsv) params.set('bucketStates', stateCsv);
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
        outDir,
        tracerTarget
    } = ctx;

    const target = tracerTarget || { type: 'bu', bu: bu != null ? String(bu) : null };

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

    const collatedBlock =
        target.type === 'collated'
            ? {
                  label: target.label || 'Collated',
                  businessUnits: Array.isArray(target.businessUnits)
                      ? target.businessUnits.slice()
                      : [],
                  regionTargets: Array.isArray(target.regionTargets)
                      ? target.regionTargets.map((t) => ({
                            kind: t.kind,
                            key: t.key,
                            label: t.label || t.key
                        }))
                      : []
              }
            : null;

    const filters = {
        bu: target.type === 'bu' && target.bu ? String(target.bu) : null,
        tracerScope: target.type,
        region:
            target.type === 'region'
                ? { kind: target.kind, key: target.key, label: target.label || target.key }
                : null,
        collated: collatedBlock,
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

    let note = `tracer-run: bucketed ${ALL_SPECIALTY_CODES.length} test code(s) from Listec`;
    if (target.type === 'region') note += `; region=${target.kind}:${target.label || target.key}`;
    if (target.type === 'collated') {
        const buN = collatedBlock ? collatedBlock.businessUnits.length : 0;
        const regN = collatedBlock ? collatedBlock.regionTargets.length : 0;
        note += `; collated=${buN} BU(s) + ${regN} region(s) [SID-deduped]`;
    }

    const filtersApplied = {
        query: requestUrl ? requestUrl.split('?')[1] || '' : '',
        notes: [note],
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
        tracerScope: target.type,
        region:
            target.type === 'region'
                ? { kind: target.kind, key: target.key, label: target.label || target.key }
                : null,
        collated: collatedBlock,
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
 * @param {unknown} optsRegions - body.regions `{ cities:[{key,label}], states:[…] }`
 */
function parseRegions(optsRegions) {
    const raw = optsRegions && typeof optsRegions === 'object' ? optsRegions : {};
    /** @type {Array<{ key: string; label?: string } | string>} */
    const cities = Array.isArray(raw.cities) ? raw.cities : [];
    /** @type {Array<{ key: string; label?: string } | string>} */
    const states = Array.isArray(raw.states) ? raw.states : [];
    /** @type {Record<string, string>} */
    const cityLabels = {};
    /** @type {Record<string, string>} */
    const stateLabels = {};

    /** @type {string[]} */
    const cityKeys = [
        ...new Set(
            cities
                .map((c) => {
                    const o = typeof c === 'string' ? { key: c, label: c } : c || {};
                    const k = String(o.key ?? '')
                        .trim()
                        .toUpperCase();
                    if (!k) return '';
                    cityLabels[k] =
                        String(o.label ?? o.key ?? k)
                            .trim() || k;
                    return k;
                })
                .filter(Boolean)
        )
    ];
    /** @type {string[]} */
    const stateKeys = [
        ...new Set(
            states
                .map((s) => {
                    const o = typeof s === 'string' ? { key: s, label: s } : s || {};
                    const k = String(o.key ?? '')
                        .trim()
                        .toUpperCase();
                    if (!k) return '';
                    stateLabels[k] =
                        String(o.label ?? o.key ?? k)
                            .trim() || k;
                    return k;
                })
                .filter(Boolean)
        )
    ];

    /** @type {{ kind: 'city' | 'state'; key: string; label: string }[]} */
    const targets = [];
    for (const key of stateKeys) targets.push({ kind: 'state', key, label: stateLabels[key] });
    for (const key of cityKeys) targets.push({ kind: 'city', key, label: cityLabels[key] });
    return { cityKeys, stateKeys, targets };
}

/**
 * Tracer salesperson chips — body.salesPeople: `[{ id, label }]`.
 * @returns {{ targets: { kind: 'sales'; key: string; label: string }[] }}
 */
function parseSalesPeople(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    /** @type {{ kind: 'sales'; key: string; label: string }[]} */
    const targets = [];
    for (const o of arr) {
        if (!o || typeof o !== 'object') continue;
        const id = o.id != null ? String(o.id).trim() : '';
        if (!id) continue;
        const label = o.label != null ? String(o.label).trim() : id;
        targets.push({ kind: 'sales', key: id, label: label || id });
    }
    return { targets };
}

/**
 * Bulk-fetch MCC client codes for selected sales user ids via Listec.
 * @param {string} apiBase
 * @param {{ kind: string; key: string; label: string }[]} salesTargets
 * @returns {Promise<Map<string, string[]>>}
 */
async function fetchSalesCodesByListec(apiBase, salesTargets) {
    /** @type {Map<string, string[]>} */
    const map = new Map();
    if (!salesTargets.length) return map;
    const ids = [...new Set(salesTargets.map((t) => String(t.key).trim()).filter(Boolean))].join(',');
    if (!ids) return map;
    const base = apiBase.replace(/\/$/, '');
    const url = `${base}/api/tracer/sales-marketing-users/codes?ids=${encodeURIComponent(ids)}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Listec sales codes API ${res.status}: ${text.slice(0, 500)}`);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        throw new Error(`Listec sales codes non-JSON: ${e.message}`);
    }
    const cbu =
        payload && payload.codesByUser && typeof payload.codesByUser === 'object' ? payload.codesByUser : {};
    for (const id of ids.split(',')) {
        const k = String(id).trim();
        if (!k) continue;
        const rawArr = Array.isArray(cbu[k]) ? cbu[k] : [];
        const codes = [...new Set(rawArr.map((c) => String(c).trim().toUpperCase()).filter(Boolean))];
        map.set(k, codes);
    }
    return map;
}

/** @param {{ kind: string; key: string; label: string }} targ */
function scopeProgressLabel(targ) {
    if (targ.kind === 'sales') return `Sales · ${targ.label}`;
    if (targ.kind === 'city') return `City · ${targ.label}`;
    return `State · ${targ.label}`;
}

async function fetchTracerPayload(apiBase, { bu, fromDate, toDate, fromHour, toHour, cityKeys, stateKeys }) {
    const qs = buildQueryString({
        bu,
        fromDate,
        toDate,
        fromHour,
        toHour,
        bucketCodes: ALL_SPECIALTY_CODES,
        bucketCityKeys: cityKeys && cityKeys.length ? cityKeys : undefined,
        bucketStateKeys: stateKeys && stateKeys.length ? stateKeys : undefined
    });
    const url = `${apiBase}/api/worksheet-reports/packages?${qs}`;
    console.log(`[tracer-sql] GET ${url}`);
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();
    if (!res.ok) {
        throw new Error(`Listec API ${res.status} (${bu || 'global'}): ${text.slice(0, 500)}`);
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        throw new Error(`Listec non-JSON (${bu || 'global'}): ${e.message}`);
    }
    return { url, payload };
}

/**
 * Phase 12 by-codes path. Calls /api/worksheet-reports/packages-by-codes,
 * which delegates to dbo.usp_listec_worksheet_report_by_codes (TVP filter)
 * — so MSSQL only returns SIDs owned by `codes`. Geography bucketing is no
 * longer needed because the SP IS the geographic filter.
 */
async function fetchTracerPayloadByCodes(
    apiBase,
    { bu, fromDate, toDate, fromHour, toHour, codes }
) {
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
    params.set('bucketTestCodes', ALL_SPECIALTY_CODES.join(','));
    params.set('clientCodes', codes.join(','));

    const url = `${apiBase}/api/worksheet-reports/packages-by-codes?${params.toString()}`;
    console.log(`[tracer-sql] GET ${url} (${codes.length} client codes)`);
    // Bound the call so a wedged MSSQL session surfaces as a tile-level error
    // instead of an indefinite "Running..." spinner. Default 4 minutes, tuneable
    // via TRACER_BY_CODES_TIMEOUT_MS in case a wide window genuinely needs more.
    const timeoutMs = Math.max(
        30_000,
        Number(process.env.TRACER_BY_CODES_TIMEOUT_MS) || 240_000
    );
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    let text;
    try {
        res = await fetch(url, {
            headers: { Accept: 'application/json' },
            signal: ctrl.signal
        });
        text = await res.text();
    } catch (e) {
        if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message)))) {
            throw new Error(
                `Listec by-codes timeout after ${timeoutMs}ms (${bu || 'no-bu'}, ${codes.length} codes)`
            );
        }
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        throw new Error(
            `Listec by-codes API ${res.status} (${bu || 'no-bu'}): ${text.slice(0, 500)}`
        );
    }
    let payload;
    try {
        payload = JSON.parse(text);
    } catch (e) {
        throw new Error(`Listec by-codes non-JSON (${bu || 'no-bu'}): ${e.message}`);
    }
    return { url, payload };
}

/**
 * Merge multiple /packages-by-codes payloads into one. Used when a region
 * chip is combined with a list of BUs — we issue one /packages-by-codes
 * call per BU (with that BU as `businessUnitId` plus the region's codes)
 * and merge the responses so a single artefact represents the whole
 * BU x region intersection.
 */
function mergeByCodesPayloads(payloads) {
    const arr = (Array.isArray(payloads) ? payloads : []).filter(Boolean);
    if (arr.length === 1) return arr[0];

    const mergedRows = [];
    const sidsByTestCode = {};
    const resultRowsByTestCode = {};
    for (const code of ALL_SPECIALTY_CODES) {
        sidsByTestCode[code.toLowerCase()] = new Set();
        resultRowsByTestCode[code.toLowerCase()] = 0;
    }

    for (const p of arr) {
        for (const row of Array.isArray(p.rows) ? p.rows : []) {
            mergedRows.push(row);
        }
        const codeBuckets = (p && p.sidsByTestCode) || {};
        for (const [code, sids] of Object.entries(codeBuckets)) {
            if (!sidsByTestCode[code]) sidsByTestCode[code] = new Set();
            for (const s of Array.isArray(sids) ? sids : []) {
                sidsByTestCode[code].add(String(s));
            }
        }
        const rowBuckets = (p && p.resultRowsByTestCode) || {};
        for (const [code, n] of Object.entries(rowBuckets)) {
            resultRowsByTestCode[code] = (resultRowsByTestCode[code] || 0) + (Number(n) || 0);
        }
    }

    const bracket = aggregateBracketsFromPackageRows(mergedRows);
    /** @type {Record<string,string[]>} */
    const sidsByTestCodeOut = {};
    for (const [code, set] of Object.entries(sidsByTestCode)) {
        sidsByTestCodeOut[code] = [...set].sort();
    }

    return {
        ...bracket,
        sidsByTestCode: sidsByTestCodeOut,
        resultRowsByTestCode,
        filters: arr[0].filters || null,
        resolved: arr[0].resolved || null,
        rows: bracket.rows
    };
}

/**
 * Merge an arbitrary mix of /packages and /packages-by-codes payloads into a
 * single collated payload that dedupes SIDs across all sources.
 *
 * The crucial difference vs `mergeByCodesPayloads` is the `rows`-level dedup:
 * when BU=AGRA and City=Haldwani both pull the same sample, the per-BU and
 * per-region payloads each contain that row. Concatenating them would double
 * the bracket counts (Letter Heads, Other tests) and inflate `sidsTotal`.
 * We dedup by `sid` BEFORE feeding `aggregateBracketsFromPackageRows`, then
 * union the per-test-code SID sets so specialty tiles also count each tube
 * once.
 *
 * `resultRowsByTestCode` is the LIS row count for each test code (rows in
 * tbl_med_mcc_patient_test_result) — it cannot be naturally deduped from
 * payload data, so we sum it. The user-visible counts (letter heads,
 * envelopes, urine containers, EDTA/citrate/heparin tubes) all come from
 * the deduped row+SID sets and are dedup-correct.
 *
 * @param {object[]} payloads
 */
function mergeCollatedPayloads(payloads) {
    const arr = (Array.isArray(payloads) ? payloads : []).filter(Boolean);
    if (arr.length === 0) {
        const empty = aggregateBracketsFromPackageRows([]);
        const sidsByTestCode = {};
        const resultRowsByTestCode = {};
        for (const code of ALL_SPECIALTY_CODES) {
            sidsByTestCode[code.toLowerCase()] = [];
            resultRowsByTestCode[code.toLowerCase()] = 0;
        }
        return {
            ...empty,
            sidsByTestCode,
            resultRowsByTestCode,
            filters: null,
            resolved: null,
            rows: empty.rows
        };
    }

    const seenSids = new Set();
    const dedupedRows = [];
    for (const p of arr) {
        for (const row of Array.isArray(p.rows) ? p.rows : []) {
            const sid = String(row && row.sid != null ? row.sid : '').trim();
            // Rows without a SID can never collide on dedup. Keep them so
            // bracket aggregation still reflects "Other tests" rows that may
            // legitimately lack a sid (defensive — current LIS rows always
            // have one).
            if (sid) {
                if (seenSids.has(sid)) continue;
                seenSids.add(sid);
            }
            dedupedRows.push(row);
        }
    }

    const sidsByTestCode = {};
    for (const code of ALL_SPECIALTY_CODES) {
        sidsByTestCode[code.toLowerCase()] = new Set();
    }
    const resultRowsByTestCode = {};
    for (const code of ALL_SPECIALTY_CODES) {
        resultRowsByTestCode[code.toLowerCase()] = 0;
    }
    for (const p of arr) {
        const codeBuckets = (p && p.sidsByTestCode) || {};
        for (const [code, sids] of Object.entries(codeBuckets)) {
            const lc = String(code).toLowerCase();
            if (!sidsByTestCode[lc]) sidsByTestCode[lc] = new Set();
            for (const s of Array.isArray(sids) ? sids : []) {
                sidsByTestCode[lc].add(String(s));
            }
        }
        const rowBuckets = (p && p.resultRowsByTestCode) || {};
        for (const [code, n] of Object.entries(rowBuckets)) {
            const lc = String(code).toLowerCase();
            resultRowsByTestCode[lc] = (resultRowsByTestCode[lc] || 0) + (Number(n) || 0);
        }
    }

    const bracket = aggregateBracketsFromPackageRows(dedupedRows);
    /** @type {Record<string,string[]>} */
    const sidsByTestCodeOut = {};
    for (const [code, set] of Object.entries(sidsByTestCode)) {
        sidsByTestCodeOut[code] = [...set].sort();
    }

    return {
        ...bracket,
        sidsByTestCode: sidsByTestCodeOut,
        resultRowsByTestCode,
        filters: arr[0].filters || null,
        resolved: arr[0].resolved || null,
        rows: bracket.rows
    };
}

/**
 * Phase 12 chip resolver bridge. Loads server/sync/resolveClientCodes only
 * when needed so this file stays usable from contexts where Postgres isn't
 * configured (e.g. one-off CLI runs).
 *
 * @returns {Promise<null | { resolveClientCodes: typeof import('../../server/sync/resolveClientCodes')['resolveClientCodes'] }>}
 */
function loadResolverModule() {
    try {
        return Promise.resolve(require('../../server/sync/resolveClientCodes'));
    } catch (e) {
        console.warn(
            `[tracer-sql] resolveClientCodes module unavailable: ${e && e.message ? e.message : e}`
        );
        return Promise.resolve(null);
    }
}

function tracerByCodesEnabled() {
    const v = String(process.env.TRACER_RESOLVE_CODES_VIA_PG || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/** @returns {void} */
function assertTracerPayload(payload, { needGeo, label }) {
    if (!payload || typeof payload.sidsByTestCode !== 'object') {
        throw new Error(`Listec response missing sidsByTestCode for ${label} — redeploy/restart Listec.`);
    }
    if (
        needGeo &&
        typeof payload.sidsByCity !== 'object' &&
        typeof payload.sidsByState !== 'object'
    ) {
        throw new Error(
            `Region bucketing missing on Listec response for ${label}. Deploy Listec with bucketCities/bucketStates and grant listec_ro SELECT on Noble.dbo.tbl_med_mcc_unit_master so MCC lookup can populate geography buckets.`
        );
    }
}

function writeSixModesForPayload(payload, meta) {
    const {
        tracerTarget,
        fromDate,
        toDate,
        fromHour,
        toHour,
        listecApiBase,
        url,
        orgId,
        outDir,
        baseMsOffset
    } = meta;

    /** @type {Record<string,string>} */
    const runIds = {};
    let lastMain = null;
    let lastPkg = null;
    const modes = ['general', ...SPECIALTY_MODES.map((m) => m.mode)];
    /** @type {Record<string,string[]|null>} */
    const codesByMode = { general: null };
    /** @type {Record<string,string|null>} */
    const blobKeyByMode = { general: null };
    for (const m of SPECIALTY_MODES) {
        codesByMode[m.mode] = m.codes;
        blobKeyByMode[m.mode] = m.blobKey;
    }

    for (let mi = 0; mi < modes.length; mi++) {
        const mode = modes[mi];
        const startedAtIso = new Date(baseMsOffset + mi).toISOString();
        const runId = startedAtIso.replace(/[:.]/g, '-');
        const dispBu =
            tracerTarget.type === 'bu'
                ? tracerTarget.bu
                : tracerTarget.label || (tracerTarget.type === 'collated' ? 'Collated' : '');
        const written = writeModeArtefact({
            mode,
            blobKey: blobKeyByMode[mode],
            codes: codesByMode[mode] || [],
            payload,
            bu: dispBu,
            fromDate,
            toDate,
            fromHour,
            toHour,
            listecApiBase,
            requestUrl: url,
            startedAtIso,
            runId,
            orgId,
            outDir,
            tracerTarget
        });
        runIds[mode] = written.runId;
        lastMain = written.outMainPath;
        lastPkg = written.outPackagesPath;
    }
    return { runIds, lastOutMainPath: lastMain, lastOutPackagesPath: lastPkg };
}

/**
 * @param {object} opts
 * @param {{ cities?: object[]; states?: object[] }} [opts.regions]
 * @param {(item: { bu: string, state: string, runIds?: object, error?: string|null }) => void} [opts.onProgress]
 *
 * @returns {Promise<{ items: object[], regionItems: object[], completed: string[], failed: string[], regionCompleted: string[], regionFailed: string[], buPayloadList: object[] }>}
 */
async function runTracerBatch(opts) {
    const businessUnits = Array.isArray(opts.businessUnits) ? opts.businessUnits.slice() : [];
    const { cityKeys, stateKeys, targets } = parseRegions(opts.regions);
    const { targets: salesTargets } = parseSalesPeople(opts.salesPeople);
    const hasBu = businessUnits.length > 0;
    const hasReg = targets.length > 0;
    const hasSales = salesTargets.length > 0;

    if (!hasBu && !hasReg && !hasSales) {
        const err = new Error('runTracerBatch: pass businessUnits, regions (cities/states), and/or salesPeople.');
        err.code = 'TRACER_NO_SCOPE';
        throw err;
    }

    const apiBase = (opts.listecApiBase || process.env.LISTEC_API_BASE_URL || DEFAULT_API_BASE).replace(/\/$/, '');
    const orgId = opts.orgId || 'org-default';
    const outDir = path.isAbsolute(opts.outDir)
        ? opts.outDir
        : path.resolve(process.cwd(), opts.outDir || './out');
    const concurrency = opts.concurrency != null ? Number(opts.concurrency) : 3;
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const useByCodesForRegions = hasReg && tracerByCodesEnabled();

    // Pre-resolve city/state -> client_codes per chip target so:
    //  - Region calls can hit the new dbo.usp_listec_worksheet_report_by_codes
    //    instead of the legacy bucket-cities post-aggregation path.
    //  - We can fast-fail a chip whose codes don't resolve (likely a stale
    //    client_locations sync or a missing region alias) before it ever
    //    reaches MSSQL.
    /** @type {Map<string, string[]>} key = `${kind}:${key}` -> code[] */
    const codesByTarget = new Map();
    if (useByCodesForRegions) {
        const resolverMod = await loadResolverModule();
        if (!resolverMod) {
            throw new Error(
                'TRACER_RESOLVE_CODES_VIA_PG=1 but server/sync/resolveClientCodes not loadable. Ship the api-matter sync module or unset the flag.'
            );
        }
        for (const targ of targets) {
            const cityArg = targ.kind === 'city' ? [targ.key] : [];
            const stateArg = targ.kind === 'state' ? [targ.key] : [];
            const rows = await resolverMod.resolveClientCodes({
                cityKeys: cityArg,
                stateKeys: stateArg
            });
            const codes = rows.map((r) => String(r.code).toUpperCase());
            codesByTarget.set(`${targ.kind}:${targ.key}`, codes);
        }
    }
    if (hasSales) {
        const salesMap = await fetchSalesCodesByListec(apiBase, salesTargets);
        for (const t of salesTargets) {
            codesByTarget.set(`sales:${t.key}`, salesMap.get(String(t.key).trim()) || []);
        }
    }

    // Collate short-circuit: produce ONE artefact pair that represents the
    // SID-deduplicated union of every selected scope (BUs and regions). This
    // bypasses the per-BU and per-region writers entirely so the result wall
    // shows a single "Collated" row.
    if (opts.collate === true) {
        const scopeBits = [];
        if (targets.length) scopeBits.push(`${targets.length} region${targets.length === 1 ? '' : 's'}`);
        if (salesTargets.length) scopeBits.push(`${salesTargets.length} sales`);
        const collateLabel =
            opts.collateLabel ||
            `Collated · ${businessUnits.length} BU${businessUnits.length === 1 ? '' : 's'}` +
                (scopeBits.length ? ` + ${scopeBits.join(' + ')}` : '');

        const collatedItem = {
            bu: collateLabel,
            state: 'running',
            runIds: {},
            error: null,
            lastOutMainPath: null,
            lastOutPackagesPath: null
        };
        onProgress({ ...collatedItem });

        try {
            // Region resolver. We need codes for the by-codes calls; the
            // earlier pre-resolve only ran when useByCodes was true. For
            // collate we always prefer by-codes for region scopes because
            // the legacy bucketCities path drains the whole DB, which is
            // exactly what collate is meant to avoid (and we already fail
            // multi-region runs without by-codes — see prior fix).
            if (hasReg && codesByTarget.size === 0) {
                const resolverMod = await loadResolverModule();
                if (!resolverMod) {
                    throw new Error(
                        'Collate requires server/sync/resolveClientCodes (Postgres mirror). Set TRACER_RESOLVE_CODES_VIA_PG=1 and ensure the api-matter app is on the same compose network.'
                    );
                }
                for (const targ of targets) {
                    const cityArg = targ.kind === 'city' ? [targ.key] : [];
                    const stateArg = targ.kind === 'state' ? [targ.key] : [];
                    const rows = await resolverMod.resolveClientCodes({
                        cityKeys: cityArg,
                        stateKeys: stateArg
                    });
                    const codes = rows.map((r) => String(r.code).toUpperCase());
                    codesByTarget.set(`${targ.kind}:${targ.key}`, codes);
                }
            }
            if (hasSales) {
                const salesMap = await fetchSalesCodesByListec(apiBase, salesTargets);
                for (const t of salesTargets) {
                    codesByTarget.set(`sales:${t.key}`, salesMap.get(String(t.key).trim()) || []);
                }
            }

            const regionConcurrencyForCollate = Math.max(
                1,
                Number(opts.regionConcurrency) ||
                    Number(process.env.TRACER_REGION_CONCURRENCY) ||
                    Math.min(4, Math.max(2, concurrency))
            );

            // BU pass: per-BU drain (no geo filter, since we want the whole
            // BU's SIDs and the dedup happens later).
            const buTasks = businessUnits.map((bu) => async () => {
                try {
                    const { payload } = await fetchTracerPayload(apiBase, {
                        bu,
                        fromDate: opts.fromDate,
                        toDate: opts.toDate,
                        fromHour: opts.fromHour,
                        toHour: opts.toHour,
                        cityKeys: [],
                        stateKeys: []
                    });
                    assertTracerPayload(payload, { needGeo: false, label: `BU=${bu}` });
                    return payload;
                } catch (e) {
                    console.warn(
                        `[tracer-sql] collate BU=${bu} failed: ${e && e.message ? e.message : e}`
                    );
                    return null;
                }
            });

            /** @type {{ kind: string; key: string; label: string }[]} */
            const collateScopeTargets = [];
            for (const t of targets) collateScopeTargets.push(t);
            for (const t of salesTargets) collateScopeTargets.push(t);

            // Region / sales scopes: per-code-list by-codes call, no BU filter.
            const regionTasks = collateScopeTargets.map((targ) => async () => {
                const codes = codesByTarget.get(`${targ.kind}:${targ.key}`) || [];
                if (codes.length === 0) {
                    const hint =
                        targ.kind === 'sales'
                            ? 'check LIS User Client Mapping for this user'
                            : 'run /api/admin/client-locations/sync';
                    console.warn(`[tracer-sql] collate scope ${targ.kind}:${targ.key} has no codes — skipping (${hint}).`);
                    return null;
                }
                try {
                    const { payload } = await fetchTracerPayloadByCodes(apiBase, {
                        bu: undefined,
                        fromDate: opts.fromDate,
                        toDate: opts.toDate,
                        fromHour: opts.fromHour,
                        toHour: opts.toHour,
                        codes
                    });
                    return payload;
                } catch (e) {
                    console.warn(
                        `[tracer-sql] collate scope ${targ.kind}:${targ.key} failed: ${e && e.message ? e.message : e}`
                    );
                    return null;
                }
            });

            const [buPayloads, regPayloads] = await Promise.all([
                runWithConcurrency(buTasks, concurrency),
                runWithConcurrency(regionTasks, regionConcurrencyForCollate)
            ]);

            const collected = [...buPayloads, ...regPayloads].filter(Boolean);
            if (collected.length === 0) {
                throw new Error(
                    'Collate produced no payloads (all BU + region/sales scope calls failed). Check Listec logs.'
                );
            }

            const merged = mergeCollatedPayloads(collected);
            const tracerTarget = {
                type: 'collated',
                label: collateLabel,
                businessUnits: businessUnits.slice(),
                regionTargets: collateScopeTargets.map((t) => ({
                    kind: t.kind,
                    key: t.key,
                    label: t.label
                }))
            };
            const w = writeSixModesForPayload(merged, {
                tracerTarget,
                fromDate: opts.fromDate,
                toDate: opts.toDate,
                fromHour: opts.fromHour,
                toHour: opts.toHour,
                listecApiBase: apiBase,
                url: `${apiBase}/api/worksheet-reports/packages?[collated]`,
                orgId,
                outDir,
                baseMsOffset: Date.now()
            });
            collatedItem.runIds = w.runIds;
            collatedItem.lastOutMainPath = w.lastOutMainPath;
            collatedItem.lastOutPackagesPath = w.lastOutPackagesPath;
            collatedItem.state = 'done';
            collatedItem.error = null;
            onProgress({ ...collatedItem });

            return {
                items: [],
                regionItems: [],
                completed: [],
                failed: [],
                regionCompleted: [],
                regionFailed: [],
                buPayloadList: [],
                collatedItems: [collatedItem],
                collatedCompleted: [collatedItem.bu],
                collatedFailed: []
            };
        } catch (e) {
            collatedItem.state = 'failed';
            collatedItem.error = String(e && e.message ? e.message : e);
            onProgress({ ...collatedItem });
            return {
                items: [],
                regionItems: [],
                completed: [],
                failed: [],
                regionCompleted: [],
                regionFailed: [],
                buPayloadList: [],
                collatedItems: [collatedItem],
                collatedCompleted: [],
                collatedFailed: [collatedItem.bu]
            };
        }
    }

    /** @type {object[]} Legacy-path payload list (only populated when region by-codes is off). */
    const buPayloadList = [];

    /** @type {{ bu: string, state: string, runIds: Record<string,string>, error: string|null, lastOutMainPath: string|null, lastOutPackagesPath: string|null }[]} */
    const items = hasBu
        ? businessUnits.map((bu) => ({
              bu,
              state: 'queued',
              runIds: {},
              error: null,
              lastOutMainPath: null,
              lastOutPackagesPath: null
          }))
        : [];

    for (const it of items) onProgress({ ...it });

    if (hasBu) {
        // Bucket-region params on the legacy /packages endpoint are only
        // needed when the synthetic-region merge will consume them. The new
        // by-codes path filters at the SP, so the BU pass can stay minimal.
        const geoKeysForFetch =
            hasReg && !useByCodesForRegions ? { cityKeys, stateKeys } : { cityKeys: [], stateKeys: [] };

        const tasks = businessUnits.map((bu, i) => async () => {
            const item = items[i];
            item.state = 'running';
            onProgress({ ...item });
            try {
                const { url, payload } = await fetchTracerPayload(apiBase, {
                    bu,
                    fromDate: opts.fromDate,
                    toDate: opts.toDate,
                    fromHour: opts.fromHour,
                    toHour: opts.toHour,
                    cityKeys: geoKeysForFetch.cityKeys,
                    stateKeys: geoKeysForFetch.stateKeys
                });
                // Geo bucketing is needed only when the legacy synthetic-merge
                // path will consume it (i.e. region targets exist AND we are
                // NOT using by-codes).
                assertTracerPayload(payload, {
                    needGeo: hasReg && !useByCodesForRegions,
                    label: `BU=${bu}`
                });
                if (!useByCodesForRegions) buPayloadList.push(payload);
                const w = writeSixModesForPayload(payload, {
                    tracerTarget: { type: 'bu', bu },
                    fromDate: opts.fromDate,
                    toDate: opts.toDate,
                    fromHour: opts.fromHour,
                    toHour: opts.toHour,
                    listecApiBase: apiBase,
                    url,
                    orgId,
                    outDir,
                    baseMsOffset: Date.now()
                });
                item.runIds = w.runIds;
                item.lastOutMainPath = w.lastOutMainPath;
                item.lastOutPackagesPath = w.lastOutPackagesPath;
                item.state = 'done';
                item.error = null;
            } catch (e) {
                item.state = 'failed';
                item.error = String(e && e.message ? e.message : e);
            }
            onProgress({ ...item });
            return item;
        });

        await runWithConcurrency(tasks, concurrency);
    }

    /** Legacy global region-only fetch, only used when region by-codes is OFF. */
    if (!hasBu && hasReg && !useByCodesForRegions) {
        const { url, payload } = await fetchTracerPayload(apiBase, {
            bu: undefined,
            fromDate: opts.fromDate,
            toDate: opts.toDate,
            fromHour: opts.fromHour,
            toHour: opts.toHour,
            cityKeys,
            stateKeys
        });
        assertTracerPayload(payload, { needGeo: true, label: 'global-region' });
        buPayloadList.push(payload);
    }

    const completed = items.filter((it) => it.state === 'done').map((it) => it.bu);
    const failed = items.filter((it) => it.state === 'failed').map((it) => it.bu);

    /** Region / sales scope progress rows mimic BU shape for FanOut strip */
    /** @type {{ bu: string, state: string, runIds: Record<string,string>, error: string|null, lastOutMainPath: string|null, lastOutPackagesPath: string|null, regionKind?: string, regionKey?: string }[]} */
    const regionItems = [];
    /** @type {string[]} */
    const regionCompleted = [];
    /** @type {string[]} */
    const regionFailed = [];

    /** @type {{ kind: string; key: string; label: string }[]} */
    const allScopeTargets = [...targets, ...salesTargets];

    if (hasReg || hasSales) {
        for (const targ of allScopeTargets) {
            const progressLabel = scopeProgressLabel(targ);
            regionItems.push({
                bu: progressLabel,
                regionKind: targ.kind,
                regionKey: targ.key,
                state: 'queued',
                runIds: {},
                error: null,
                lastOutMainPath: null,
                lastOutPackagesPath: null
            });
        }
        for (const rit of regionItems) onProgress({ ...rit });

        if (useByCodesForRegions || hasSales) {
            /** Region chips (PG-resolved) and/or salesperson scopes (Listec LIS mapping). */
            const byCodeScopeTargets = [];
            if (useByCodesForRegions) {
                for (const t of targets) byCodeScopeTargets.push(t);
            }
            if (hasSales) {
                for (const t of salesTargets) byCodeScopeTargets.push(t);
            }

            const regionConcurrency = Math.max(
                1,
                Number(opts.regionConcurrency) ||
                    Number(process.env.TRACER_REGION_CONCURRENCY) ||
                    Math.min(4, Math.max(2, concurrency))
            );
            const regionTasks = byCodeScopeTargets.map((targ, i) => async () => {
                const rit = regionItems[i];
                rit.state = 'running';
                onProgress({ ...rit });
                const progressLabel = scopeProgressLabel(targ);
                try {
                    const codes = codesByTarget.get(`${targ.kind}:${targ.key}`) || [];
                    if (codes.length === 0) {
                        const msg =
                            targ.kind === 'sales'
                                ? `No client codes mapped for salesperson ${targ.label} — check LIS User Client Mapping (Listec sales endpoint).`
                                : `No client codes mapped to ${progressLabel} in client_locations — run sync (POST /api/admin/client-locations/sync) or check region_aliases.`;
                        throw new Error(msg);
                    }
                    let payload;
                    let lastUrl;
                    if (hasBu) {
                        const perBu = await Promise.all(
                            businessUnits.map((bu) =>
                                fetchTracerPayloadByCodes(apiBase, {
                                    bu,
                                    fromDate: opts.fromDate,
                                    toDate: opts.toDate,
                                    fromHour: opts.fromHour,
                                    toHour: opts.toHour,
                                    codes
                                })
                            )
                        );
                        const successful = perBu.filter((r) => r && r.payload);
                        if (successful.length === 0) {
                            throw new Error(
                                `Listec by-codes returned no payloads for any BU (${progressLabel}).`
                            );
                        }
                        payload = mergeByCodesPayloads(successful.map((r) => r.payload));
                        lastUrl = successful[successful.length - 1].url;
                    } else {
                        const r = await fetchTracerPayloadByCodes(apiBase, {
                            bu: undefined,
                            fromDate: opts.fromDate,
                            toDate: opts.toDate,
                            fromHour: opts.fromHour,
                            toHour: opts.toHour,
                            codes
                        });
                        payload = r.payload;
                        lastUrl = r.url;
                    }
                    const assertLabel =
                        targ.kind === 'sales' ? `Sales · ${targ.label}` : `Region ${progressLabel}`;
                    assertTracerPayload(payload, {
                        needGeo: false,
                        label: assertLabel
                    });
                    const tracerTarget = {
                        type: 'region',
                        kind: targ.kind,
                        key: targ.key,
                        label: targ.label
                    };
                    const baseMsOffset = Date.now() + i * 60000;
                    const w = writeSixModesForPayload(payload, {
                        tracerTarget,
                        fromDate: opts.fromDate,
                        toDate: opts.toDate,
                        fromHour: opts.fromHour,
                        toHour: opts.toHour,
                        listecApiBase: apiBase,
                        url: lastUrl,
                        orgId,
                        outDir,
                        baseMsOffset
                    });
                    rit.runIds = w.runIds;
                    rit.lastOutMainPath = w.lastOutMainPath;
                    rit.lastOutPackagesPath = w.lastOutPackagesPath;
                    rit.state = 'done';
                    rit.error = null;
                    regionCompleted.push(progressLabel);
                } catch (e) {
                    rit.state = 'failed';
                    rit.error = String(e && e.message ? e.message : e);
                    regionFailed.push(String(rit.bu));
                }
                onProgress({ ...rit });
            });
            await runWithConcurrency(regionTasks, regionConcurrency);
        } else if (buPayloadList.length === 0 && hasReg && !hasSales) {
            // Legacy geo path: BU calls all failed and we have no global payload.
            for (const rit of regionItems) {
                rit.state = 'failed';
                rit.error =
                    'No Listec payloads succeeded for this batch — expand geo stats after BU runs succeed.';
                regionFailed.push(String(rit.bu));
                onProgress({ ...rit });
            }
        } else if (hasReg && !useByCodesForRegions) {
            // Legacy synthetic-merge path (TRACER_RESOLVE_CODES_VIA_PG off). Geo only — sales always use by-codes above.
            let rIdx = 0;
            for (let i = 0; i < targets.length; i++) {
                const targ = targets[i];
                const rit = regionItems[i];
                rit.state = 'running';
                onProgress({ ...rit });
                try {
                    const synthetic = buildSyntheticRegionalPayload(buPayloadList, targ.kind, targ.key);
                    const progressLabel =
                        targ.kind === 'city' ? `City · ${targ.label}` : `State · ${targ.label}`;
                    const tracerTarget = { type: 'region', kind: targ.kind, key: targ.key, label: targ.label };
                    const baseMsOffset = Date.now() + rIdx * 60000;
                    rIdx++;

                    assertTracerPayload(synthetic, {
                        needGeo: false,
                        label: `Region ${progressLabel}`
                    });
                    const w = writeSixModesForPayload(synthetic, {
                        tracerTarget,
                        fromDate: opts.fromDate,
                        toDate: opts.toDate,
                        fromHour: opts.fromHour,
                        toHour: opts.toHour,
                        listecApiBase: apiBase,
                        url: `${apiBase}/api/worksheet-reports/packages?[synthetic-region:${progressLabel}]`,
                        orgId,
                        outDir,
                        baseMsOffset
                    });
                    rit.runIds = w.runIds;
                    rit.lastOutMainPath = w.lastOutMainPath;
                    rit.lastOutPackagesPath = w.lastOutPackagesPath;
                    rit.state = 'done';
                    rit.error = null;
                    regionCompleted.push(progressLabel);
                } catch (e) {
                    rit.state = 'failed';
                    rit.error = String(e && e.message ? e.message : e);
                    regionFailed.push(String(rit.bu));
                }
                onProgress({ ...rit });
            }
        }
    }

    return {
        items,
        regionItems,
        completed,
        failed,
        regionCompleted,
        regionFailed,
        buPayloadList,
        collatedItems: [],
        collatedCompleted: [],
        collatedFailed: []
    };
}

module.exports = {
    runTracerBatch,
    parseTracerRegions: parseRegions,
    parseTracerSalesPeople: parseSalesPeople,
    ALL_SPECIALTY_CODES,
    SPECIALTY_MODES,
    URINE_CONTAINER_TEST_CODES,
    EDTA_VIAL_TEST_CODES,
    CITRATE_VIAL_TEST_CODES,
    S_HEPARIN_TEST_CODES,
    L_HEPARIN_TEST_CODES
};
