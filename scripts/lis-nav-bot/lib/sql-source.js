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

    const outDirRaw = opts.outDir != null ? opts.outDir : process.env.LIS_OUT_DIR || './out';
    const outDir = path.isAbsolute(String(outDirRaw))
        ? String(outDirRaw)
        : path.resolve(process.cwd(), String(outDirRaw));

    /** @type {string[]} */
    const notes = [];
    const qs = buildQueryString(filters, notes);

    /** @type {object} */
    const result = {
        startedAt,
        readOnly: true,
        source: 'sql',
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
        result.message = `dry-run: would call GET ${apiBaseClean}/api/worksheet-reports/packages?${qs}`;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            outMainPath = path.join(outDir, `run-${stamp}.json`);
            fs.writeFileSync(outMainPath, JSON.stringify(result, null, 2), 'utf8');
            console.log(`[sql] dry-run wrote ${outMainPath}`);
        } catch (e) {
            result.errors.push(`dry-run write: ${e.message}`);
            exitCode = 1;
        }
        return { result, outMainPath, outPackagesPath, exitCode };
    }

    const url = `${apiBaseClean}/api/worksheet-reports/packages?${qs}`;
    console.log(`[sql] GET ${url}`);

    let payload;
    try {
        const r = await fetch(url, { headers: { Accept: 'application/json' } });
        const text = await r.text();
        if (!r.ok) {
            throw new Error(`Listec API ${r.status}: ${text.slice(0, 500)}`);
        }
        try {
            payload = JSON.parse(text);
        } catch (parseErr) {
            throw new Error(`Listec API returned non-JSON: ${parseErr.message}`);
        }
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        result.errors.push(`Listec API call failed: ${msg}`);
        exitCode = 1;
        try {
            fs.mkdirSync(outDir, { recursive: true });
            outMainPath = path.join(outDir, `run-${stamp}-error.json`);
            fs.writeFileSync(outMainPath, JSON.stringify(result, null, 2), 'utf8');
        } catch (_) {}
        return { result, outMainPath, outPackagesPath, exitCode };
    }

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
            recoveryEvents: [],
            completedPagerPages: [1],
            lastCompletedPagerPage: 1,
            partial: false,
        };
        fs.writeFileSync(pkgFile, JSON.stringify(packagesPayload, null, 2), 'utf8');
        outPackagesPath = pkgFile;
        result.scrapePackages.packagesJsonPath = pkgFile;
        console.log(`[sql] wrote ${pkgFile}`);

        const outFile = path.join(outDir, `run-${stamp}.json`);
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
        outMainPath = outFile;
        console.log(`[sql] wrote ${outFile}`);
        console.log(
            `[sql] ${rowCount} row(s), ${sids.length} SID(s), ${uniqueLabelCount} unique label(s), ${otherTestsRowCount} Other tests row(s).`
        );
    } catch (e) {
        result.errors.push(`SQL write: ${e.message}`);
        exitCode = 1;
    }

    return { result, outMainPath, outPackagesPath, exitCode };
}

module.exports = { runViaSql };
