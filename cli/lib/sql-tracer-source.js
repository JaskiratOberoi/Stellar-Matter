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

    const filters = {
        bu: target.type === 'bu' && target.bu ? String(target.bu) : null,
        tracerScope: target.type,
        region:
            target.type === 'region'
                ? { kind: target.kind, key: target.key, label: target.label || target.key }
                : null,
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
        const dispBu = tracerTarget.type === 'bu' ? tracerTarget.bu : tracerTarget.label;
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
    const hasBu = businessUnits.length > 0;
    const hasReg = targets.length > 0;

    if (!hasBu && !hasReg) {
        const err = new Error('runTracerBatch: pass businessUnits and/or regions (cities/states).');
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

    /** @type {object[]} Listec payload bodies (successful fetches only) — used to merge geography when BU+region combined */
    /** @type {object[]} */
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
        const geoKeysForFetch = hasReg ? { cityKeys, stateKeys } : { cityKeys: [], stateKeys: [] };

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
                assertTracerPayload(payload, { needGeo: hasReg, label: `BU=${bu}` });
                buPayloadList.push(payload);
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

    /** Single global fetch — region-only (no BU filter) — only if no BU list */
    if (!hasBu && hasReg) {
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
        // BU items empty — region loops below consume buPayloadList
    }

    const completed = items.filter((it) => it.state === 'done').map((it) => it.bu);
    const failed = items.filter((it) => it.state === 'failed').map((it) => it.bu);

    /** Region progress rows mimic BU shape for FanOut strip */
    /** @type {{ bu: string, state: string, runIds: Record<string,string>, error: string|null, lastOutMainPath: string|null, lastOutPackagesPath: string|null, regionKind?: string, regionKey?: string }[]} */
    const regionItems = [];
    /** @type {string[]} */
    const regionCompleted = [];
    /** @type {string[]} */
    const regionFailed = [];

    if (hasReg) {
        if (buPayloadList.length === 0) {
            for (const targ of targets) {
                const progressLabel =
                    targ.kind === 'city' ? `City · ${targ.label}` : `State · ${targ.label}`;
                regionItems.push({
                    bu: progressLabel,
                    regionKind: targ.kind,
                    regionKey: targ.key,
                    state: 'failed',
                    runIds: {},
                    error: 'No Listec payloads succeeded for this batch — expand geo stats after BU runs succeed.',
                    lastOutMainPath: null,
                    lastOutPackagesPath: null
                });
                regionFailed.push(progressLabel);
            }
            for (const rit of regionItems) onProgress({ ...rit });
        } else {
            let rIdx = 0;
            for (const targ of targets) {
                const progressLabel =
                    targ.kind === 'city' ? `City · ${targ.label}` : `State · ${targ.label}`;
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
        buPayloadList
    };
}

module.exports = {
    runTracerBatch,
    parseTracerRegions: parseRegions,
    ALL_SPECIALTY_CODES,
    SPECIALTY_MODES,
    URINE_CONTAINER_TEST_CODES,
    EDTA_VIAL_TEST_CODES,
    CITRATE_VIAL_TEST_CODES,
    S_HEPARIN_TEST_CODES,
    L_HEPARIN_TEST_CODES
};
