'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { loadLisNavBotEnv } = require('./lib/load-env');
loadLisNavBotEnv(__dirname);

const { runLisNavBot } = require('./lib/run');

const app = express();
const PORT = Number(process.env.LIS_UI_PORT || 4377);

// Behind Caddy on the host, the request reaches Express via the docker bridge
// (source IP = gateway), not the real client. Trust one proxy hop so req.ip
// reflects X-Forwarded-For — required for express-rate-limit's IP-based keying
// on POST /api/auth/login. '1' (not 'true') because true would let any caller
// spoof X-Forwarded-For when there is no proxy in front.
app.set('trust proxy', 1);
const HOST = process.env.LIS_UI_HOST || '127.0.0.1';

function listecApiBase() {
    return (process.env.LISTEC_API_BASE_URL || 'http://127.0.0.1:3100').replace(/\/$/, '');
}

function resolveOutDir() {
    // Default to scripts/lis-nav-bot/out (next to this file) so the dashboard
    // works whether started from the repo root (`npm run start`), inside Docker
    // (cwd=/app), or the legacy `cd scripts/lis-nav-bot && npm run ui` path.
    const raw = process.env.LIS_OUT_DIR || path.join(__dirname, 'out');
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const PACKAGE_PAGES_PATH = path.join(__dirname, 'data', 'package-pages.json');

/** @param {unknown} label */
function normalizePackageLabel(label) {
    return String(label || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

/** Read mapping from disk (call on each /api/package-pages hit so edits apply without restart). */
function readPackagePagesFile() {
    /** @type {{ version: number, pages: Record<string, number>, normalizedMap: Record<string, number> }} */
    const empty = { version: 1, pages: {}, normalizedMap: {} };
    try {
        if (!fs.existsSync(PACKAGE_PAGES_PATH)) return empty;
        const raw = fs.readFileSync(PACKAGE_PAGES_PATH, 'utf8');
        const j = JSON.parse(raw);
        const pages = j.pages && typeof j.pages === 'object' ? j.pages : {};
        /** @type {Record<string, number>} */
        const normalizedMap = {};
        for (const [k, v] of Object.entries(pages)) {
            const n = Number(v);
            if (!Number.isFinite(n)) continue;
            normalizedMap[normalizePackageLabel(k)] = n;
        }
        return {
            version: typeof j.version === 'number' ? j.version : 1,
            pages,
            normalizedMap
        };
    } catch {
        return empty;
    }
}

/**
 * @param {object} result
 * @param {{ outMainPath?: string|null, outPackagesPath?: string|null }} paths
 */
function buildSummary(result, paths = {}) {
    if (!result) return null;
    const sp = result.scrapePackages || {};
    const { normalizedMap } = readPackagePagesFile();
    /** @type {{ label: string, count: number, pagesPerReport: number|null }[]|null} */
    let packageLabelRows = null;
    if (sp.enabled) {
        const occ = sp.labelOccurrences && typeof sp.labelOccurrences === 'object' ? sp.labelOccurrences : {};
        packageLabelRows = Object.entries(occ)
            .map(([label, count]) => {
                const norm = normalizePackageLabel(label);
                const ppr = normalizedMap[norm];
                return {
                    label,
                    count: Number(count) || 0,
                    pagesPerReport: ppr != null && Number.isFinite(Number(ppr)) ? Number(ppr) : null
                };
            })
            .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    }
    const otherTestsRowCount =
        sp.enabled && typeof sp.otherTestsRowCount === 'number' && Number.isFinite(sp.otherTestsRowCount)
            ? Math.max(0, Math.floor(sp.otherTestsRowCount))
            : 0;
    const recoveryEvents =
        Array.isArray(sp.recoveryEvents) && sp.enabled
            ? sp.recoveryEvents.map((ev) => ({
                  attempt: ev.attempt,
                  reason: ev.reason != null ? String(ev.reason) : '',
                  atPagerPage: ev.atPagerPage != null ? ev.atPagerPage : null,
                  at: ev.at != null ? String(ev.at) : '',
                  succeeded: !!ev.succeeded,
                  error: ev.error != null ? String(ev.error) : undefined
              }))
            : null;
    const recoveryCount = recoveryEvents ? recoveryEvents.length : 0;
    const lastCompletedPagerPage =
        sp.enabled &&
        sp.lastCompletedPagerPage != null &&
        Number.isFinite(Number(sp.lastCompletedPagerPage))
            ? Number(sp.lastCompletedPagerPage)
            : null;
    return {
        startedAt: result.startedAt,
        dryRun: !!result.dryRun,
        scrapePackages: !!sp.enabled,
        pagesScanned: sp.pagesScanned,
        rowCount: sp.rowCount,
        uniqueLabelCount: sp.uniqueLabelCount,
        sidsOnPage1: Array.isArray(result.sidsFoundOnPage1) ? result.sidsFoundOnPage1.length : 0,
        errors: result.errors && result.errors.length ? result.errors : [],
        outMainPath: paths.outMainPath || null,
        outPackagesPath: paths.outPackagesPath || sp.packagesJsonPath || null,
        packageLabelRows,
        otherTestsRowCount,
        filtersRequested: result.filtersRequested || null,
        filtersApplied: result.filtersApplied || null,
        pageVisits:
            Array.isArray(sp.pageVisits) && sp.enabled
                ? sp.pageVisits.map((v) => ({
                      index: v.index,
                      pagerPage: v.pagerPage ?? null,
                      rowCount: v.rowCount,
                      rowsWithBracketLabels: v.rowsWithBracketLabels
                  }))
                : null,
        recoveryCount,
        lastCompletedPagerPage,
        recoveryEvents
    };
}

function makeOtherTestsPinned(otherTestsRowCount) {
    const n = Math.max(0, Math.floor(Number(otherTestsRowCount) || 0));
    if (n <= 0) return null;
    return { label: 'Other tests', count: n, pagesPerReport: 1, isOther: true };
}

/**
 * @param {Record<string, unknown>} occ
 * @param {number} otherN
 * @param {Record<string, number>} normalizedMap
 */
function computePrintedTotals(occ, otherN, normalizedMap) {
    const pinned = makeOtherTestsPinned(otherN);
    let knownSum = 0;
    let unknownLabels = 0;
    /** @param {{ label: string, count: number, pagesPerReport: number|null, isOther?: boolean }} row */
    const add = (row) => {
        const c = Number(row.count) || 0;
        if (row.isOther) {
            knownSum += c * (row.pagesPerReport != null ? Number(row.pagesPerReport) : 1);
            return;
        }
        if (row.pagesPerReport != null && Number.isFinite(Number(row.pagesPerReport))) {
            knownSum += c * Number(row.pagesPerReport);
        } else unknownLabels++;
    };
    if (pinned) add({ ...pinned, isOther: true });
    for (const [label, count] of Object.entries(occ || {})) {
        const norm = normalizePackageLabel(label);
        const ppr = normalizedMap[norm];
        add({
            label,
            count: Number(count) || 0,
            pagesPerReport: ppr != null && Number.isFinite(Number(ppr)) ? Number(ppr) : null
        });
    }
    return { knownSum, unknownLabels };
}

/**
 * @param {string} outDir
 * @param {string} packagesFileName
 */
function buildTileFromRunFiles(outDir, packagesFileName) {
    const m = /^run-(.+)-packages\.json$/i.exec(packagesFileName);
    if (!m) return null;
    const id = m[1];
    const pkgPath = path.join(outDir, packagesFileName);
    const mainPath = path.join(outDir, `run-${id}.json`);
    /** @type {Record<string, unknown>} */
    let pkg;
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch {
        return null;
    }
    let main = null;
    if (fs.existsSync(mainPath)) {
        try {
            main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
        } catch {
            main = null;
        }
    }
    const occ = pkg.labelOccurrences && typeof pkg.labelOccurrences === 'object' ? pkg.labelOccurrences : {};
    const otherN =
        pkg.otherTestsRowCount != null && Number.isFinite(Number(pkg.otherTestsRowCount))
            ? Math.max(0, Math.floor(Number(pkg.otherTestsRowCount)))
            : 0;
    const { normalizedMap } = readPackagePagesFile();
    const labelRows = Object.entries(occ)
        .map(([label, count]) => {
            const norm = normalizePackageLabel(label);
            const ppr = normalizedMap[norm];
            const pprNum = ppr != null && Number.isFinite(Number(ppr)) ? Number(ppr) : null;
            return {
                label,
                count: Number(count) || 0,
                pagesPerReport: pprNum,
                envelopeKind: pprNum == null ? 'small' : pprNum > 10 ? 'big' : 'small',
                envelopeEstimated: pprNum == null
            };
        })
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
    const { knownSum, unknownLabels } = computePrintedTotals(occ, otherN, normalizedMap);
    const pinned = makeOtherTestsPinned(otherN);
    const envelopes = { big: 0, small: 0, total: 0, unknown: 0 };
    for (const r of labelRows) {
        if (r.pagesPerReport == null) {
            envelopes.unknown += r.count;
            envelopes.small += r.count;
        } else if (r.pagesPerReport > 10) {
            envelopes.big += r.count;
        } else {
            envelopes.small += r.count;
        }
    }
    if (pinned) envelopes.small += pinned.count;
    envelopes.total = envelopes.big + envelopes.small;
    const occSum = Object.values(occ).reduce((s, v) => s + (Number(v) || 0), 0);
    const occurrences = occSum + (pinned ? pinned.count : 0);
    const uniqueLabels =
        pkg.uniqueLabelCount != null && Number.isFinite(Number(pkg.uniqueLabelCount))
            ? Number(pkg.uniqueLabelCount)
            : labelRows.length + (pinned ? 1 : 0);
    const filter = (pkg.filter && typeof pkg.filter === 'object' ? pkg.filter : null) || {};
    const req = (main && main.filtersRequested) || {};
    const bu =
        (filter.bu != null && String(filter.bu).trim() && String(filter.bu).trim()) ||
        (req.bu != null && String(req.bu).trim() && String(req.bu).trim()) ||
        '—';
    const source = (main && main.source) || (pkg.source && String(pkg.source)) || 'scrape';
    const sidCount = main && Array.isArray(main.sidsFoundOnPage1) ? main.sidsFoundOnPage1.length : 0;
    const errors = (main && Array.isArray(main.errors) ? main.errors : []) || [];
    const startedAt = (main && main.startedAt) || pkg.startedAt || null;
    const top50 = labelRows.slice(0, 50);
    return {
        id,
        startedAt,
        finishedAt: null,
        source,
        bu,
        fromDate: filter.fromDate != null ? String(filter.fromDate) : req.fromDate != null ? String(req.fromDate) : null,
        toDate: filter.toDate != null ? String(filter.toDate) : req.toDate != null ? String(req.toDate) : null,
        fromHour: filter.fromHour != null ? filter.fromHour : req.fromHour,
        toHour: filter.toHour != null ? filter.toHour : req.toHour,
        totals: {
            totalPrintedPages: knownSum,
            estimated: unknownLabels > 0,
            sids: sidCount,
            occurrences,
            uniqueLabels,
            otherTestsRowCount: otherN,
            errors: errors.length,
            envelopes: {
                big: envelopes.big,
                small: envelopes.small,
                total: envelopes.total,
                estimated: envelopes.unknown > 0
            }
        },
        paths: {
            mainJson: fs.existsSync(mainPath) ? mainPath : null,
            packagesJson: pkgPath
        },
        labelRows: top50,
        labelRowCount: labelRows.length,
        filtersApplied: (main && main.filtersApplied) || (pkg.filtersApplied && typeof pkg.filtersApplied === 'object' ? pkg.filtersApplied : null)
    };
}

async function fetchListecLookups() {
    try {
        const r = await fetch(`${listecApiBase()}/api/lookups`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        return {
            businessUnits: Array.isArray(j.businessUnits) ? j.businessUnits : [],
            statuses: Array.isArray(j.statuses) ? j.statuses : [],
            departments: Array.isArray(j.departments) ? j.departments : [],
            error: null
        };
    } catch (e) {
        return {
            businessUnits: [],
            statuses: [],
            departments: [],
            error: String(e && e.message ? e : e)
        };
    }
}

/** @type {{ state: 'idle'|'running', runId: string|null, startedAt: string|null, error: string|null, summary: object|null, result: object|null, outMainPath: string|null, outPackagesPath: string|null, exitCode: number|null, fanOut?: object|null, lastFanOut?: object|null }} */
let jobState = {
    state: 'idle',
    runId: null,
    startedAt: null,
    error: null,
    summary: null,
    result: null,
    outMainPath: null,
    outPackagesPath: null,
    exitCode: null,
    fanOut: null,
    lastFanOut: null
};

app.use(express.json({ limit: '64kb' }));

// ---------------------------------------------------------------------------
// Phase 3 auth wedge: when the server/ workspace is installed (bcryptjs, pg,
// jsonwebtoken resolvable at the workspace root) and DATABASE_URL is set,
// gate every /api/* route except the public whitelist below. When auth deps
// are absent (legacy single-user mode), this whole block silently no-ops so
// the dashboard keeps working without Postgres.
// ---------------------------------------------------------------------------
let auth = null;
let authApi = null;
let adminApi = null;
let runMigrate = null;
let auditLog = null;
try {
    const serverDir = path.resolve(__dirname, '..', '..', 'server');
    auth = require(path.join(serverDir, 'auth'));
    authApi = require(path.join(serverDir, 'routes', 'authApi'));
    adminApi = require(path.join(serverDir, 'routes', 'adminApi'));
    runMigrate = require(path.join(serverDir, 'db', 'migrate')).migrate;
    auditLog = require(path.join(serverDir, 'audit')).logAudit;
} catch (e) {
    // Auth deps not installed yet — fall through and serve the legacy open dashboard.
    if (process.env.DATABASE_URL) {
        console.warn('[stellar-matter] DATABASE_URL set but auth modules failed to load:', e.message);
    }
}

if (authApi) app.use('/api/auth', authApi);
if (adminApi) app.use('/api/admin', adminApi);

if (auth) {
    // Public whitelist: health + auth login. Everything else under /api requires a token
    // when DATABASE_URL is set (auth.requireAuth gracefully no-ops when it isn't).
    app.use((req, res, next) => {
        if (!req.path.startsWith('/api/')) return next();
        if (req.path === '/api/health') return next();
        if (req.path.startsWith('/api/auth/')) return next();
        if (req.path.startsWith('/api/admin/')) return next(); // adminApi installs its own gates
        return auth.requireAuth(req, res, next);
    });
}

if (runMigrate) {
    Promise.resolve()
        .then(() => runMigrate())
        .catch((err) => console.error('[stellar-matter] migration failed:', err));
}

const requireSuperAdmin = auth ? auth.requireRole('super_admin') : (_req, _res, next) => next();

app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
});

app.get('/api/package-pages', (_req, res) => {
    const { version, pages } = readPackagePagesFile();
    res.json({ version, pages });
});

app.get('/api/run/status', (_req, res) => {
    res.json({
        state: jobState.state,
        runId: jobState.runId,
        startedAt: jobState.startedAt,
        error: jobState.error,
        summary: jobState.summary,
        resultSummary: jobState.state === 'idle' ? jobState.summary : null,
        result: jobState.state === 'idle' ? jobState.result : null,
        outMainPath: jobState.state === 'idle' ? jobState.outMainPath : null,
        outPackagesPath: jobState.state === 'idle' ? jobState.outPackagesPath : null,
        exitCode: jobState.state === 'idle' ? jobState.exitCode : null,
        fanOut: jobState.fanOut,
        lastFanOut: jobState.state === 'idle' ? jobState.lastFanOut : null
    });
});

/**
 * @param {Record<string, unknown>} body
 */
function normalizeBusinessUnits(body) {
    const raw = body.businessUnits;
    if (!Array.isArray(raw)) return [];
    return [...new Set(raw.map((s) => String(s || '').trim()).filter(Boolean))];
}

/**
 * @param {Record<string, unknown>} body
 */
function resolveSource(body) {
    const raw = body.source != null ? String(body.source) : process.env.LIS_SOURCE || '';
    return raw && /^sql$/i.test(raw) ? 'sql' : 'scrape';
}

/**
 * @param {string | null | undefined} p
 */
function runChildIdFromOutMainPath(p) {
    if (!p) return null;
    const m = /[/\\]run-(.+)\.json$/i.exec(String(p));
    return m ? m[1] : null;
}

app.get('/api/bu', async (_req, res) => {
    const data = await fetchListecLookups();
    res.json(data);
});

app.get('/api/runs/tiles', (_req, res) => {
    const outDir = resolveOutDir();
    /** @type {object[]} */
    const tiles = [];
    /** @type {object[]} */
    const errors = [];
    try {
        if (!fs.existsSync(outDir)) {
            return res.json({ tiles: [], errors: [], outDir });
        }
        const names = fs.readdirSync(outDir);
        for (const name of names) {
            if (!/^run-.+-packages\.json$/i.test(name)) continue;
            if (name.includes('-error')) continue;
            try {
                const full = path.join(outDir, name);
                const st = fs.statSync(full);
                const t = buildTileFromRunFiles(outDir, name);
                if (t) {
                    tiles.push({ ...t, _mtime: st.mtimeMs });
                }
            } catch (e) {
                errors.push({ file: name, error: String(e && e.message ? e.message : e) });
            }
        }
        tiles.sort((a, b) => {
            const ta = a.startedAt ? Date.parse(String(a.startedAt)) : 0;
            const tb = b.startedAt ? Date.parse(String(b.startedAt)) : 0;
            if (ta !== tb) return tb - ta;
            return (b._mtime || 0) - (a._mtime || 0);
        });
        const cleaned = tiles.map(({ _mtime, ...rest }) => rest);
        res.json({ tiles: cleaned, errors, outDir });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
});

app.post('/api/run', requireSuperAdmin, async (req, res) => {
    if (jobState.state === 'running') {
        return res.status(409).json({ error: 'A run is already in progress.' });
    }
    if (process.env.LIS_ALLOW_WRITES === '1') {
        return res.status(400).json({ error: 'LIS_ALLOW_WRITES=1 — this tool refuses to start.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const source = resolveSource(body);
    const businessUnits = normalizeBusinessUnits(body);
    if (businessUnits.length && source !== 'sql') {
        return res.status(400).json({
            error:
                'Multi–business unit runs require SQL source. Switch to “SQL (Listec)” or clear extra BU chips and use a single BU for web scrape.'
        });
    }

    const startedAt = new Date().toISOString();
    const runId = startedAt.replace(/[:.]/g, '-');

    jobState = {
        state: 'running',
        runId,
        startedAt,
        error: null,
        summary: null,
        result: null,
        outMainPath: null,
        outPackagesPath: null,
        exitCode: null,
        fanOut: null,
        lastFanOut: null
    };

    if (auditLog) {
        // Fire-and-forget: audit insert doesn't gate the run kicking off.
        auditLog(req, {
            action: 'run.start',
            targetType: 'run',
            targetId: runId,
            outcome: 'success',
            metadata: {
                source,
                business_units: businessUnits.length ? businessUnits : (body && body.bu ? [body.bu] : []),
                from_date: body && body.fromDate ? String(body.fromDate) : null,
                to_date: body && body.toDate ? String(body.toDate) : null,
                fan_out: businessUnits.length > 0
            }
        }).catch(() => {});
    }

    /** @type {Record<string, unknown>} */
    const bodySansUnits = { ...body };
    delete bodySansUnits.businessUnits;

    setImmediate(() => {
        const runFanOutSerial = async () => {
            /** @type {{ bu: string, state: string, childRunId?: string|null, error?: string|null, outMainPath?: string|null, outPackagesPath?: string|null, exitCode?: number }[]} */
            const items = businessUnits.map((bu) => ({ bu, state: 'queued', childRunId: null, error: null }));
            /** @type {string[]} */
            const completed = [];
            /** @type {string[]} */
            const failed = [];
            jobState.fanOut = {
                batchRunId: runId,
                queued: businessUnits.slice(),
                completed: [],
                failed: [],
                items
            };

            let lastR = /** @type {{ result: object, outMainPath: string|null, outPackagesPath: string|null, exitCode: number }|null} */ (null);
            for (let i = 0; i < businessUnits.length; i++) {
                const bu = businessUnits[i];
                items[i].state = 'running';
                const childStartedAt = new Date().toISOString();
                try {
                    const r = await runLisNavBot({
                        ...bodySansUnits,
                        source: 'sql',
                        bu,
                        startedAt: childStartedAt
                    });
                    lastR = r;
                    const cid = runChildIdFromOutMainPath(r.outMainPath);
                    items[i].state = r.exitCode === 0 ? 'done' : 'failed';
                    items[i].childRunId = cid;
                    items[i].outMainPath = r.outMainPath;
                    items[i].outPackagesPath = r.outPackagesPath;
                    items[i].exitCode = r.exitCode;
                    if (r.exitCode === 0) {
                        completed.push(bu);
                        jobState.fanOut.completed.push(bu);
                    } else {
                        failed.push(bu);
                        jobState.fanOut.failed.push(bu);
                        items[i].error = (r.result.errors && r.result.errors[0]) || 'Run failed';
                    }
                } catch (e) {
                    const msg = String(e && e.message ? e.message : e);
                    items[i].state = 'failed';
                    items[i].error = msg;
                    failed.push(bu);
                    jobState.fanOut.failed.push(bu);
                }
            }

            const anyFail = failed.length > 0;
            const errMsg = anyFail ? `Failed BU(s): ${failed.join(', ')}` : null;
            const fanOutSnapshot = {
                batchRunId: runId,
                queued: businessUnits.slice(),
                completed: completed.slice(),
                failed: failed.slice(),
                items: items.map((x) => ({ ...x }))
            };

            if (lastR) {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: anyFail ? errMsg : null,
                    summary: buildSummary(lastR.result, {
                        outMainPath: lastR.outMainPath,
                        outPackagesPath: lastR.outPackagesPath
                    }),
                    result: lastR.result,
                    outMainPath: lastR.outMainPath,
                    outPackagesPath: lastR.outPackagesPath,
                    exitCode: anyFail ? 1 : lastR.exitCode,
                    fanOut: null,
                    lastFanOut: fanOutSnapshot
                };
            } else {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: errMsg || 'No runs completed',
                    summary: null,
                    result: null,
                    outMainPath: null,
                    outPackagesPath: null,
                    exitCode: 1,
                    fanOut: null,
                    lastFanOut: fanOutSnapshot
                };
            }
        };

        const runSingle = async () => {
            try {
                const r = await runLisNavBot({ ...body, startedAt });
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: r.exitCode !== 0 ? (r.result.errors && r.result.errors[0]) || 'Run failed' : null,
                    summary: buildSummary(r.result, { outMainPath: r.outMainPath, outPackagesPath: r.outPackagesPath }),
                    result: r.result,
                    outMainPath: r.outMainPath,
                    outPackagesPath: r.outPackagesPath,
                    exitCode: r.exitCode,
                    fanOut: null,
                    lastFanOut: null
                };
            } catch (e) {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: String(e && e.message ? e.message : e),
                    summary: null,
                    result: null,
                    outMainPath: null,
                    outPackagesPath: null,
                    exitCode: 1,
                    fanOut: null,
                    lastFanOut: null
                };
            }
        };

        if (businessUnits.length) {
            runFanOutSerial().catch((e) => {
                const partial = jobState.fanOut;
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: String(e && e.message ? e.message : e),
                    summary: null,
                    result: null,
                    outMainPath: null,
                    outPackagesPath: null,
                    exitCode: 1,
                    fanOut: null,
                    lastFanOut: partial
                };
            });
        } else {
            runSingle().catch((e) => {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: String(e && e.message ? e.message : e),
                    summary: null,
                    result: null,
                    outMainPath: null,
                    outPackagesPath: null,
                    exitCode: 1,
                    fanOut: null,
                    lastFanOut: null
                };
            });
        }
    });

    const payload =
        businessUnits.length > 0
            ? { runId, startedAt, queued: businessUnits.slice(), completed: [], failed: [] }
            : { runId, startedAt };
    res.json(payload);
});

app.get('/api/runs', (_req, res) => {
    const outDir = resolveOutDir();
    try {
        if (!fs.existsSync(outDir)) {
            return res.json({ runs: [], errors: [], outDir });
        }
        const names = fs.readdirSync(outDir);
        const runs = [];
        const errors = [];
        for (const name of names) {
            if (!/^run-.+\.json$/i.test(name)) continue;
            const full = path.join(outDir, name);
            let stat;
            try {
                stat = fs.statSync(full);
            } catch {
                continue;
            }
            if (!stat.isFile()) continue;
            if (name.includes('-packages')) continue;
            if (name.includes('-error')) {
                const id = name.replace(/^run-/, '').replace(/-error\.json$/i, '');
                errors.push({ id, fileName: name, mtime: stat.mtime.toISOString() });
                continue;
            }
            const id = name.replace(/^run-/, '').replace(/\.json$/i, '');
            let preview = {};
            try {
                const raw = fs.readFileSync(full, 'utf8');
                const j = JSON.parse(raw);
                preview = {
                    startedAt: j.startedAt,
                    dryRun: j.dryRun,
                    scrapeEnabled: !!(j.scrapePackages && j.scrapePackages.enabled),
                    pagesScanned: j.scrapePackages && j.scrapePackages.pagesScanned,
                    rowCount: j.scrapePackages && j.scrapePackages.rowCount,
                    sidCount: Array.isArray(j.sidsFoundOnPage1) ? j.sidsFoundOnPage1.length : 0
                };
            } catch {
                preview = { parseError: true };
            }
            runs.push({
                id,
                fileName: name,
                mtime: stat.mtime.toISOString(),
                preview
            });
        }
        runs.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
        errors.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
        res.json({ runs, errors, outDir });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
});

app.get('/api/runs/:id', (req, res) => {
    const id = String(req.params.id || '')
        .replace(/[^0-9A-Za-z-_.TZ]/g, '')
        .trim();
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const outDir = resolveOutDir();
    const mainPath = path.join(outDir, `run-${id}.json`);
    const pkgPath = path.join(outDir, `run-${id}-packages.json`);
    if (!fs.existsSync(mainPath)) {
        return res.status(404).json({ error: 'Run file not found', mainPath });
    }
    try {
        const main = JSON.parse(fs.readFileSync(mainPath, 'utf8'));
        let packages = null;
        if (fs.existsSync(pkgPath)) {
            packages = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        }
        res.json({ id, main, packages, paths: { main: mainPath, packages: packages ? pkgPath : null } });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
});

const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(PORT, HOST, () => {
    console.log(`lis-nav-bot UI at http://${HOST}:${PORT}/`);
});
