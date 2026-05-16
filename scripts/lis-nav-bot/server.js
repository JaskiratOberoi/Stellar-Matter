'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

// Phase 11 (cli-rename): library code moved to top-level cli/lib/. Server
// still lives here for now because tooling + Docker COPY paths still point
// at scripts/lis-nav-bot/server.js, but the lib imports are pointed at the
// new home so the move is one-directional.
const { loadLisNavBotEnv } = require('../../cli/lib/load-env');
loadLisNavBotEnv(__dirname);

const { runLisNavBot } = require('../../cli/lib/run');
const { runTracerBatch, parseTracerRegions, parseTracerSalesPeople, ALL_SPECIALTY_CODES } = require('../../cli/lib/sql-tracer-source');

// Phase 8 + Phase 12 share the same Postgres pool. We require it here once
// so /api/regions, /api/runs/:id authz, and tracer can all query without
// each call site repeating the require + null-check dance.
let pgPoolMod = null;
try {
    pgPoolMod = require('../../server/db/pool');
} catch {
    /* db helpers absent in pre-Phase-8 environments */
}
function useDatabase() {
    return Boolean(pgPoolMod && pgPoolMod.useDatabase && pgPoolMod.useDatabase());
}
function getPool() {
    if (!pgPoolMod) throw new Error('server/db/pool is unavailable');
    return pgPoolMod.getPool();
}

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
    const req = (main && main.filtersRequested && typeof main.filtersRequested === 'object' ? main.filtersRequested : {}) || {};
    const filtRegion =
        filter.region && typeof filter.region === 'object' && String(filter.region.key || '').trim() ? filter.region : null;
    const reqRegion =
        req.region && typeof req.region === 'object' && String(req.region.key || '').trim() ? req.region : null;
    const region =
        filtRegion || reqRegion
            ? {
                  kind: String((filtRegion || reqRegion).kind || '').trim(),
                  key: String((filtRegion || reqRegion).key || '').trim(),
                  label:
                      String((filtRegion || reqRegion).label || (filtRegion || reqRegion).key || '')
                          .trim() || String((filtRegion || reqRegion).key || '').trim()
              }
            : null;
    let tracerScope = String(filter.tracerScope || req.tracerScope || '').trim().toLowerCase();
    if (tracerScope !== 'region' && region) tracerScope = 'region';
    if (!tracerScope || tracerScope === 'bu') tracerScope = region ? 'region' : 'bu';
    const kind = tracerScope === 'region' ? 'region' : 'bu';
    let bu =
        (filter.bu != null && String(filter.bu).trim()) || (req.bu != null && String(req.bu).trim()) || '';
    if (!bu && kind === 'region' && region && region.label) bu = region.label;
    bu = String(bu).trim() || '—';
    const source = (main && main.source) || (pkg.source && String(pkg.source)) || 'scrape';
    const sidCount = main && Array.isArray(main.sidsFoundOnPage1) ? main.sidsFoundOnPage1.length : 0;
    const errors = (main && Array.isArray(main.errors) ? main.errors : []) || [];
    const startedAt = (main && main.startedAt) || pkg.startedAt || null;
    const top50 = labelRows.slice(0, 50);
    // mode + urineContainers come from the run artefact when it was an
    // urine-container run; fall back to 'general' for the 100+ pre-existing
    // run files on disk that predate this feature. The TileWall uses mode to
    // strict-filter which tab a tile belongs to (Letter Heads/Envelopes vs
    // Urine Containers).
    const mode =
        (main && main.mode === 'urine_containers' && 'urine_containers') ||
        (pkg.mode === 'urine_containers' && 'urine_containers') ||
        (main && main.mode === 'edta_vials' && 'edta_vials') ||
        (pkg.mode === 'edta_vials' && 'edta_vials') ||
        (main && main.mode === 'citrate_vials' && 'citrate_vials') ||
        (pkg.mode === 'citrate_vials' && 'citrate_vials') ||
        (main && main.mode === 's_heparin' && 's_heparin') ||
        (pkg.mode === 's_heparin' && 's_heparin') ||
        (main && main.mode === 'l_heparin' && 'l_heparin') ||
        (pkg.mode === 'l_heparin' && 'l_heparin') ||
        'general';
    const urineContainers =
        mode === 'urine_containers'
            ? (main && main.urineContainers) || (pkg.urineContainers && typeof pkg.urineContainers === 'object' ? pkg.urineContainers : null)
            : null;
    const edtaVials =
        mode === 'edta_vials'
            ? (main && main.edtaVials) || (pkg.edtaVials && typeof pkg.edtaVials === 'object' ? pkg.edtaVials : null)
            : null;
    const citrateVials =
        mode === 'citrate_vials'
            ? (main && main.citrateVials) || (pkg.citrateVials && typeof pkg.citrateVials === 'object' ? pkg.citrateVials : null)
            : null;
    const sHeparin =
        mode === 's_heparin'
            ? (main && main.sHeparin) || (pkg.sHeparin && typeof pkg.sHeparin === 'object' ? pkg.sHeparin : null)
            : null;
    const lHeparin =
        mode === 'l_heparin'
            ? (main && main.lHeparin) || (pkg.lHeparin && typeof pkg.lHeparin === 'object' ? pkg.lHeparin : null)
            : null;
    // org_id was added in Phase 10. Files written before that have neither key
    // — we treat them as belonging to 'org-default' so single-tenant deploys
    // never lose history when this code lands.
    const orgId = String(
        (main && main.org_id != null && main.org_id) ||
            (pkg.org_id != null && pkg.org_id) ||
            'org-default'
    );
    return {
        id,
        startedAt,
        finishedAt: null,
        tracerScope,
        kind,
        region,
        source,
        mode,
        urineContainers,
        edtaVials,
        citrateVials,
        sHeparin,
        lHeparin,
        orgId,
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
// Phase 8: runs ingest helpers. When DATABASE_URL is set we ingest each
// completed run into Postgres (UPSERT keyed on the on-disk filename) and
// the tile wall reads from `runs` instead of `fs.readdirSync(outDir)`. The
// disk JSON is still the canonical artefact — Postgres is a derived index.
let runsDb = null;
// Phase 12: client_locations sync. Mirrors Noble.dbo.tbl_med_mcc_unit_master
// into Postgres so Tracer Region chips + chip-to-client_codes resolution can
// answer from db-1 instead of round-tripping to MSSQL on every page load.
let clientLocationsSync = null;
try {
    const serverDir = path.resolve(__dirname, '..', '..', 'server');
    auth = require(path.join(serverDir, 'auth'));
    authApi = require(path.join(serverDir, 'routes', 'authApi'));
    adminApi = require(path.join(serverDir, 'routes', 'adminApi'));
    runMigrate = require(path.join(serverDir, 'db', 'migrate')).migrate;
    auditLog = require(path.join(serverDir, 'audit')).logAudit;
    runsDb = require(path.join(serverDir, 'db', 'runs'));
    clientLocationsSync = require(path.join(serverDir, 'sync', 'syncClientLocations'));
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
        .then(() => {
            // Phase 8: backfill any on-disk run artifacts that aren't yet in
            // Postgres. Idempotent — only runs whose source_file_mtime is
            // older than the disk file get re-ingested. Fire-and-forget so
            // the server keeps booting even if backfill takes a few seconds.
            if (runsDb) {
                return runsDb.backfillFromDisk(resolveOutDir()).catch((err) => {
                    console.warn('[stellar-matter] runs backfill failed:', err && err.message ? err.message : err);
                });
            }
        })
        .then(() => {
            // Phase 12: refresh client_locations once on boot so the Region
            // chips have up-to-date geography even if Listec was offline at
            // last cycle. Fire-and-forget; the manual POST endpoint and the
            // optional CLIENT_LOCATIONS_SYNC_INTERVAL_MIN cover the recovery
            // case if this fails (e.g. listec service still booting).
            if (!clientLocationsSync) return;
            clientLocationsSync.startClientLocationsSyncInterval({});
            return clientLocationsSync.runClientLocationsSync({}).catch((err) => {
                console.warn(
                    '[stellar-matter] client_locations boot sync failed:',
                    err && err.message ? err.message : err
                );
            });
        })
        .catch((err) => console.error('[stellar-matter] migration failed:', err));
}

const requireSuperAdmin = auth ? auth.requireRole('super_admin') : (_req, _res, next) => next();
const requireRunStarter =
    auth ? auth.requireRole('super_admin', 'operator', 'admin') : (_req, _res, next) => next();

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

/**
 * Build the same { states: [...] } tree the Listec /api/regions endpoint
 * returns, but sourced from Postgres `client_locations`. Keys (city_key /
 * state_key) are byte-identical because syncClientLocations populates them
 * via the same `normaliseCity` / `normaliseState` helpers Listec uses, so
 * persisted chip selections in LS_TRACER_REGION_SELECTION keep working.
 */
async function regionsFromPostgres() {
    if (!useDatabase()) return null;
    const pool = getPool();
    const r = await pool.query(
        `SELECT state_key, state_label, city_key, city_label,
                COUNT(*)::int AS mcc_count,
                array_agg(code ORDER BY code) AS codes
         FROM client_locations
         WHERE active = true
         GROUP BY state_key, state_label, city_key, city_label`
    );
    if (r.rows.length === 0) return null;

    /** @type {Map<string, { label: string, mccCount: number, cities: Map<string, { label: string, mccCount: number, codes: string[] }> }>} */
    const stateMap = new Map();
    for (const row of r.rows) {
        const sk = String(row.state_key || '');
        if (!sk) continue;
        let sn = stateMap.get(sk);
        if (!sn) {
            sn = { label: String(row.state_label || sk), mccCount: 0, cities: new Map() };
            stateMap.set(sk, sn);
        }
        const ck = String(row.city_key || '');
        const codes = Array.isArray(row.codes) ? row.codes.filter(Boolean).map(String) : [];
        const cn = sn.cities.get(ck) || {
            label: String(row.city_label || ck),
            mccCount: 0,
            codes: []
        };
        cn.mccCount += Number(row.mcc_count) || 0;
        for (const c of codes) cn.codes.push(c);
        sn.cities.set(ck, cn);
        sn.mccCount += Number(row.mcc_count) || 0;
    }

    const states = [];
    for (const [sk, sd] of stateMap) {
        const cities = [];
        for (const [ck, cd] of sd.cities) {
            cities.push({
                key: ck,
                label: cd.label,
                mccCount: cd.mccCount,
                codes: [...new Set(cd.codes)].sort()
            });
        }
        cities.sort((a, b) =>
            b.mccCount !== a.mccCount ? b.mccCount - a.mccCount : a.label.localeCompare(b.label)
        );
        states.push({ key: sk, label: sd.label, mccCount: sd.mccCount, cities });
    }
    states.sort((a, b) =>
        b.mccCount !== a.mccCount ? b.mccCount - a.mccCount : a.label.localeCompare(b.label)
    );
    return { states };
}

app.get('/api/regions', async (_req, res) => {
    // Phase 12: prefer Postgres (client_locations) so the chip wall doesn't
    // round-trip MSSQL on every page load. Listec stays the fallback for
    // (a) fresh deploys where the boot sync hasn't completed yet, and
    // (b) the case where DATABASE_URL is unset.
    try {
        const fromPg = await regionsFromPostgres();
        if (fromPg) {
            return res.json(fromPg);
        }
    } catch (e) {
        console.warn(
            '[stellar-matter] /api/regions Postgres path failed, falling through to Listec:',
            e && e.message ? e.message : e
        );
    }

    try {
        const base = listecApiBase();
        const url = `${base}/api/regions`;
        const r = await fetch(url);
        if (!r.ok) {
            const hint =
                r.status === 404 ?
                    `HTTP 404 from Listec (${url}). Rebuild and restart Listec: cd Listec/integration/node-mssql && npm run build && npm start. If api-matter runs in Docker, set LISTEC_API_HOST=0.0.0.0 (default) on the Listec host so host.docker.internal can connect.`
                :   `HTTP ${r.status} from Listec (${url})`;
            throw new Error(hint);
        }
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({
            error: String(e && e.message ? e.message : e),
            states: []
        });
    }
});

app.get('/api/tracer/sales-marketing-users', async (_req, res) => {
    try {
        const base = listecApiBase();
        const url = `${base}/api/tracer/sales-marketing-users`;
        const r = await fetch(url);
        if (!r.ok) {
            const text = await r.text();
            return res.status(502).json({
                error: `Listec ${r.status}: ${text.slice(0, 300)}`,
                users: []
            });
        }
        res.json(await r.json());
    } catch (e) {
        res.status(502).json({ error: String(e && e.message ? e.message : e), users: [] });
    }
});

app.get('/api/tracer/sales-marketing-users/codes', async (req, res) => {
    try {
        const ids = req.query.ids;
        if (typeof ids !== 'string' || !ids.trim()) {
            return res.status(400).json({ error: 'ids query parameter is required' });
        }
        const base = listecApiBase();
        const url = `${base}/api/tracer/sales-marketing-users/codes?ids=${encodeURIComponent(ids)}`;
        const r = await fetch(url);
        const text = await r.text();
        if (!r.ok) {
            return res.status(502).json({ error: `Listec ${r.status}: ${text.slice(0, 300)}` });
        }
        res.type('application/json').send(text);
    } catch (e) {
        res.status(502).json({ error: String(e && e.message ? e.message : e) });
    }
});

app.get('/api/runs/tiles', async (req, res) => {
    const outDir = resolveOutDir();
    // Org scoping: caller's active_org_id from JWT, with 'org-default' as the
    // single-tenant fallback. super_admin can pass ?all_orgs=1 to inspect every
    // org's data (e.g. to verify a multi-tenant migration). DB-less / open mode
    // sees everything because there's no user.
    const allOrgs = String(req.query.all_orgs || '') === '1';
    const isSuperAdmin = !!(req.user && req.user.role === 'super_admin');
    const activeOrgId = (req.user && req.user.activeOrgId) || (req.user ? 'org-default' : null);
    const filterOrgId = req.user && !(allOrgs && isSuperAdmin) ? activeOrgId : null;

    // Phase 8: prefer Postgres-backed tiles when DATABASE_URL is set. The
    // backfillFromDisk() boot hook keeps the table in sync; disk remains the
    // canonical artefact and we fall back to it on any DB error so a Postgres
    // hiccup never blanks the dashboard.
    if (runsDb && process.env.DATABASE_URL) {
        try {
            const tiles = await runsDb.listTiles({
                orgId: filterOrgId,
                allOrgs: !filterOrgId
            });
            if (Array.isArray(tiles)) {
                return res.json({
                    tiles,
                    errors: [],
                    outDir,
                    orgId: filterOrgId,
                    allOrgs: !filterOrgId,
                    source: 'postgres'
                });
            }
        } catch (e) {
            console.warn('[stellar-matter] /api/runs/tiles DB read failed, falling back to disk:', e.message);
        }
    }

    /** @type {object[]} */
    const tiles = [];
    /** @type {object[]} */
    const errors = [];
    try {
        if (!fs.existsSync(outDir)) {
            return res.json({ tiles: [], errors: [], outDir, orgId: filterOrgId, allOrgs: !filterOrgId, source: 'disk' });
        }
        const names = fs.readdirSync(outDir);
        for (const name of names) {
            if (!/^run-.+-packages\.json$/i.test(name)) continue;
            if (name.includes('-error')) continue;
            try {
                const full = path.join(outDir, name);
                const st = fs.statSync(full);
                const t = buildTileFromRunFiles(outDir, name);
                if (!t) continue;
                if (filterOrgId && t.orgId !== filterOrgId) continue;
                tiles.push({ ...t, _mtime: st.mtimeMs });
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
        res.json({ tiles: cleaned, errors, outDir, orgId: filterOrgId, allOrgs: !filterOrgId, source: 'disk' });
    } catch (e) {
        res.status(500).json({ error: String(e && e.message ? e.message : e) });
    }
});

app.post('/api/run', requireRunStarter, async (req, res) => {
    if (jobState.state === 'running') {
        return res.status(409).json({ error: 'A run is already in progress.' });
    }
    if (process.env.LIS_ALLOW_WRITES === '1') {
        return res.status(400).json({ error: 'LIS_ALLOW_WRITES=1 — this tool refuses to start.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // Admin dashboard users: SQL-only (UI hides the data-source picker). Reject
    // explicit scrape requests so tampering cannot bypass the policy.
    if (req.user && req.user.role === 'admin') {
        if (body.source != null && !/^sql$/i.test(String(body.source).trim())) {
            return res.status(400).json({ error: 'Admin role runs are restricted to SQL (Listec).' });
        }
        body.source = 'sql';
    }
    const source = resolveSource(body);
    const businessUnits = normalizeBusinessUnits(body);
    if (businessUnits.length && source !== 'sql') {
        return res.status(400).json({
            error:
                'Multi–business unit runs require SQL source. Switch to “SQL (Listec)” or clear extra BU chips and use a single BU for web scrape.'
        });
    }

    // mode whitelist. All specialty modes (urine_containers / edta_vials /
    // citrate_vials / s_heparin / l_heparin) auto-pin a fixed list of testCodes
    // in lib/sql-source.js by firing N parallel Listec calls and unioning SIDs
    // (OR semantics). They require the SQL source because the scrape path
    // doesn't accept testCode multi-targeting and would silently fall back to
    // whatever the LIS UI picks.
    //
    // Unknown modes are rejected (rather than silently downgraded to 'general')
    // so a frontend/backend version mismatch surfaces immediately instead of
    // landing a useless general-mode tile under an EDTA/Citrate/etc. slot.
    const SQL_ONLY_MODES = new Set(['urine_containers', 'edta_vials', 'citrate_vials', 's_heparin', 'l_heparin']);
    const KNOWN_MODES = new Set(['general', ...SQL_ONLY_MODES]);
    const modeRaw = body && body.mode != null ? String(body.mode).trim() : 'general';
    const mode = modeRaw === '' ? 'general' : modeRaw;
    if (!KNOWN_MODES.has(mode)) {
        return res.status(400).json({
            error: `Unknown mode "${mode}". Expected one of: ${[...KNOWN_MODES].join(', ')}. (If the dashboard sent this, the API server is older than the frontend — redeploy the api-matter container.)`
        });
    }
    if (SQL_ONLY_MODES.has(mode) && source !== 'sql') {
        const label =
            mode === 'citrate_vials'
                ? 'Citrate vial counting'
                : mode === 'edta_vials'
                  ? 'EDTA vial counting'
                  : mode === 's_heparin'
                    ? 'S.Heparin tube counting'
                    : mode === 'l_heparin'
                      ? 'L.Heparin tube counting'
                      : 'Urine container counting';
        return res.status(400).json({
            error: `${label} requires SQL source. Switch to "SQL (Listec)".`
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

    // org_id resolution: caller's active org from JWT, or 'org-default' for
    // single-tenant deploys / legacy tokens minted before Phase 10.
    const orgId = (req.user && req.user.activeOrgId) || 'org-default';

    if (auditLog) {
        // Fire-and-forget: audit insert doesn't gate the run kicking off.
        auditLog(req, {
            action: 'run.start',
            targetType: 'run',
            targetId: runId,
            outcome: 'success',
            metadata: {
                source,
                mode,
                org_id: orgId,
                test_codes:
                    mode === 'urine_containers'
                        ? ['cp004', 'mb034']
                        : mode === 'edta_vials'
                          ? ['he011', 'he022', 'he006', 'he055', 'bi127']
                          : mode === 'citrate_vials'
                            ? ['he030', 'he004', 'he016', 'hem001']
                            : mode === 's_heparin'
                              ? ['ky004', 'cp3257']
                              : mode === 'l_heparin'
                                ? ['ms091']
                                : null,
                business_units: businessUnits.length ? businessUnits : (body && body.bu ? [body.bu] : []),
                from_date: body && body.fromDate ? String(body.fromDate) : null,
                to_date: body && body.toDate ? String(body.toDate) : null,
                fan_out: businessUnits.length > 0
            }
        }).catch(() => {});
    }

    /** @type {Record<string, unknown>} */
    const bodySansUnits = { ...body, orgId };
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
                        mode,
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
                    // Phase 8: surface this child run in Postgres immediately
                    // so the tile wall sees it even before the next backfill
                    // sweep. Fire-and-forget; ingestRunSafe never throws.
                    if (runsDb && cid) {
                        runsDb.ingestRunSafe(resolveOutDir(), cid).catch(() => {});
                    }
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
                const r = await runLisNavBot({ ...body, mode, orgId, startedAt });
                // Phase 8: ingest the freshly-written run into Postgres so
                // the next /api/runs/tiles call sees it without waiting for
                // the next boot-time backfill.
                if (runsDb) {
                    const cid = runChildIdFromOutMainPath(r.outMainPath);
                    if (cid) runsDb.ingestRunSafe(resolveOutDir(), cid).catch(() => {});
                }
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

/**
 * Tracer-only: run all 6 modes (general + 5 specialty) for N BUs from a
 * single Listec SP execution per BU. Replaces the 6-step sequential
 * /api/run dance the Tracer page used to do (one POST + waitForRunIdle per
 * mode), collapsing 30 SP calls down to 2 for a 2-BU month run.
 *
 * Behaviour mirrors POST /api/run's fan-out shape so the existing run
 * status polling, RunProgress strip, and tile ingest pipeline all work
 * unchanged. The dashboard's per-mode runs continue to use /api/run.
 */
app.post('/api/tracer-run', requireRunStarter, async (req, res) => {
    if (jobState.state === 'running') {
        return res.status(409).json({ error: 'A run is already in progress.' });
    }
    if (process.env.LIS_ALLOW_WRITES === '1') {
        return res.status(400).json({ error: 'LIS_ALLOW_WRITES=1 — this tool refuses to start.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const businessUnits = normalizeBusinessUnits(body);
    if (businessUnits.length === 0) {
        const single = trimOrNullStr(body.bu);
        if (single) businessUnits.push(single);
    }
    const regInfo = parseTracerRegions(body.regions);
    const salesInfo = parseTracerSalesPeople(body.salesPeople);
    if (businessUnits.length === 0 && regInfo.targets.length === 0 && salesInfo.targets.length === 0) {
        return res.status(400).json({
            error: 'Select at least one business unit, region (state/city), and/or salesperson.'
        });
    }

    const fromDate = trimOrNullStr(body.fromDate);
    const toDate = trimOrNullStr(body.toDate);
    if (!fromDate || !toDate) {
        return res.status(400).json({ error: 'fromDate and toDate are required.' });
    }

    const fromHour = body.fromHour != null && String(body.fromHour).trim() !== '' ? Number(body.fromHour) : undefined;
    const toHour = body.toHour != null && String(body.toHour).trim() !== '' ? Number(body.toHour) : undefined;
    // Collate flag flips the tracer wall from per-BU + per-region rows into a
    // single "Collated" row whose tile counts dedupe by SID. Treated truthy
    // for any of: true, "true", 1, "1", "on", "yes" (matches our other env
    // toggle parsers; the UI sends a real boolean).
    const collate = (() => {
        const v = body.collate;
        if (v === true || v === 1) return true;
        if (typeof v === 'string') {
            const s = v.trim().toLowerCase();
            return s === '1' || s === 'true' || s === 'yes' || s === 'on';
        }
        return false;
    })();

    const startedAt = new Date().toISOString();
    const runId = startedAt.replace(/[:.]/g, '-');

    const collatedLabel = (() => {
        if (!collate) return null;
        const parts = [];
        if (regInfo.targets.length) {
            parts.push(`${regInfo.targets.length} region${regInfo.targets.length === 1 ? '' : 's'}`);
        }
        if (salesInfo.targets.length) {
            parts.push(`${salesInfo.targets.length} sales`);
        }
        const tail = parts.length ? ` + ${parts.join(' + ')}` : '';
        return `Collated · ${businessUnits.length} BU${businessUnits.length === 1 ? '' : 's'}${tail}`;
    })();

    const buProgressRows = collate
        ? []
        : businessUnits.map((bu) => ({
              bu,
              state: 'queued',
              childRunId: null,
              error: null
          }));
    /** @type {{ bu: string, state: string, childRunId: null, error: null }[]} */
    const regionProgressRows = collate
        ? []
        : regInfo.targets.map((t) => ({
              bu: t.kind === 'city' ? `City · ${t.label}` : `State · ${t.label}`,
              state: 'queued',
              childRunId: null,
              error: null
          }));
    /** @type {{ bu: string, state: string, childRunId: null, error: null }[]} */
    const salesProgressRows = collate
        ? []
        : salesInfo.targets.map((t) => ({
              bu: `Sales · ${t.label}`,
              state: 'queued',
              childRunId: null,
              error: null
          }));
    /** @type {{ bu: string, state: string, childRunId: null, error: null }[]} */
    const collatedProgressRows = collate
        ? [{ bu: collatedLabel, state: 'queued', childRunId: null, error: null }]
        : [];

    /** @type {string[]} */
    const queuedFanOutLabels = collate
        ? [collatedLabel]
        : [...businessUnits, ...regionProgressRows.map((r) => r.bu), ...salesProgressRows.map((r) => r.bu)];

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
        fanOut: {
            batchRunId: runId,
            kind: 'tracer',
            queued: queuedFanOutLabels,
            completed: [],
            failed: [],
            items: [...buProgressRows, ...regionProgressRows, ...salesProgressRows, ...collatedProgressRows]
        },
        lastFanOut: null
    };

    const orgId = (req.user && req.user.activeOrgId) || 'org-default';

    if (auditLog) {
        auditLog(req, {
            action: 'tracer-run.start',
            targetType: 'tracer-run',
            targetId: runId,
            outcome: 'success',
            metadata: {
                source: 'sql-tracer',
                org_id: orgId,
                business_units: businessUnits,
                regions: body.regions || null,
                sales_people: body.salesPeople || null,
                from_date: fromDate,
                to_date: toDate,
                bucket_test_codes: ALL_SPECIALTY_CODES,
                fan_out: queuedFanOutLabels.length > 1,
                collate
            }
        }).catch(() => {});
    }

    setImmediate(async () => {
        try {
            const onProgress = (snap) => {
                if (!jobState.fanOut || jobState.fanOut.batchRunId !== runId) return;
                const idx = jobState.fanOut.items.findIndex((it) => it.bu === snap.bu);
                if (idx < 0) return;
                jobState.fanOut.items[idx] = {
                    bu: snap.bu,
                    state: snap.state,
                    childRunId: snap.runIds && snap.runIds.general ? snap.runIds.general : null,
                    error: snap.error || null
                };
                if (snap.state === 'done' && !jobState.fanOut.completed.includes(snap.bu)) {
                    jobState.fanOut.completed.push(snap.bu);
                }
                if (snap.state === 'failed' && !jobState.fanOut.failed.includes(snap.bu)) {
                    jobState.fanOut.failed.push(snap.bu);
                }
            };

            const result = await runTracerBatch({
                businessUnits,
                regions: body.regions,
                salesPeople: body.salesPeople,
                fromDate,
                toDate,
                fromHour,
                toHour,
                orgId,
                outDir: resolveOutDir(),
                concurrency: 3,
                listecApiBase: listecApiBase(),
                onProgress,
                collate,
                collateLabel: collatedLabel
            });

            const collatedItems = Array.isArray(result.collatedItems) ? result.collatedItems : [];
            const allWrites = [...result.items, ...result.regionItems, ...collatedItems];

            // Ingest every per-mode artefact into Postgres so the tile wall
            // sees them on the next /api/runs/tiles poll without waiting for
            // the boot-time backfill sweep. Fire-and-forget per artefact;
            // ingestRunSafe never throws.
            if (runsDb) {
                for (const it of allWrites) {
                    if (it.state !== 'done') continue;
                    for (const cid of Object.values(it.runIds || {})) {
                        if (cid) runsDb.ingestRunSafe(resolveOutDir(), cid).catch(() => {});
                    }
                }
            }

            const mapSnap = (it) => ({
                bu: it.bu,
                state: it.state,
                childRunId: it.runIds && it.runIds.general ? it.runIds.general : null,
                error: it.error || null
            });

            const collatedCompleted = Array.isArray(result.collatedCompleted)
                ? result.collatedCompleted
                : [];
            const collatedFailed = Array.isArray(result.collatedFailed)
                ? result.collatedFailed
                : [];

            const fanOutSnapshot = {
                batchRunId: runId,
                kind: 'tracer',
                queued: queuedFanOutLabels.slice(),
                completed: [...result.completed, ...result.regionCompleted, ...collatedCompleted],
                failed: [...result.failed, ...result.regionFailed, ...collatedFailed],
                items: [
                    ...result.items.map(mapSnap),
                    ...result.regionItems.map(mapSnap),
                    ...collatedItems.map(mapSnap)
                ]
            };

            const anyFail =
                result.failed.length > 0 ||
                result.regionFailed.length > 0 ||
                collatedFailed.length > 0;
            const errTxt =
                anyFail ?
                    `Failed: ${[...result.failed, ...result.regionFailed, ...collatedFailed].join('; ')}`
                :   null;
            jobState = {
                state: 'idle',
                runId,
                startedAt,
                error: errTxt,
                summary: null,
                result: null,
                outMainPath: null,
                outPackagesPath: null,
                exitCode: anyFail ? 1 : 0,
                fanOut: null,
                lastFanOut: fanOutSnapshot
            };
        } catch (e) {
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
        }
    });

    res.json({
        runId,
        startedAt,
        kind: 'tracer',
        queuedLabels: queuedFanOutLabels.slice(),
        businessUnits: businessUnits.slice(),
        regionTargets: regInfo.targets.length,
        completed: [],
        failed: []
    });
});

/** @param {unknown} v */
function trimOrNullStr(v) {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
}

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

app.get('/api/runs/:id', async (req, res) => {
    const id = String(req.params.id || '')
        .replace(/[^0-9A-Za-z-_.TZ]/g, '')
        .trim();
    if (!id) return res.status(400).json({ error: 'Invalid id' });
    const outDir = resolveOutDir();
    const mainPath = path.join(outDir, `run-${id}.json`);
    const pkgPath = path.join(outDir, `run-${id}-packages.json`);

    // Phase 8: when DATABASE_URL is set, gate the response by the run's
    // org_id stored in Postgres so a user can't fetch another org's run by
    // guessing the timestamp slug. super_admin with ?all_orgs=1 bypasses.
    // The on-disk JSON files remain the canonical payload — DB is only used
    // to authorize. Falls through to a pure-disk path if the DB lookup
    // misses (e.g. backfill hasn't happened yet for a brand-new artifact).
    if (runsDb && process.env.DATABASE_URL && req.user) {
        try {
            const allOrgs = String(req.query.all_orgs || '') === '1' && req.user.role === 'super_admin';
            const pool = require('../../server/db/pool').getPool();
            const c = await pool.connect();
            try {
                const r = await c.query(`SELECT org_id FROM runs WHERE id = $1`, [id]);
                if (r.rows.length > 0 && !allOrgs) {
                    const rowOrg = r.rows[0].org_id;
                    const userOrg = req.user.activeOrgId || 'org-default';
                    if (rowOrg !== userOrg) {
                        return res.status(404).json({ error: 'Run file not found' });
                    }
                }
            } finally {
                c.release();
            }
        } catch (e) {
            console.warn('[stellar-matter] /api/runs/:id authz lookup failed:', e.message);
        }
    }

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
