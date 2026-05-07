'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');

const { loadLisNavBotEnv } = require('./lib/load-env');
loadLisNavBotEnv(__dirname);

const { runLisNavBot } = require('./lib/run');

const app = express();
const PORT = Number(process.env.LIS_UI_PORT || 4377);
const HOST = process.env.LIS_UI_HOST || '127.0.0.1';

function resolveOutDir() {
    const raw = process.env.LIS_OUT_DIR || './out';
    return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

const PACKAGE_PAGES_PATH = path.join(__dirname, 'data', 'package-pages.json');

/** @param {unknown} label */
function normalizePackageLabel(label) {
    return String(label || '')
        .replace(/\s+/g, ' ')
        .trim();
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

/** @type {{ state: 'idle'|'running', runId: string|null, startedAt: string|null, error: string|null, summary: object|null, result: object|null, outMainPath: string|null, outPackagesPath: string|null, exitCode: number|null }} */
let jobState = {
    state: 'idle',
    runId: null,
    startedAt: null,
    error: null,
    summary: null,
    result: null,
    outMainPath: null,
    outPackagesPath: null,
    exitCode: null
};

app.use(express.json({ limit: '64kb' }));

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
        exitCode: jobState.state === 'idle' ? jobState.exitCode : null
    });
});

app.post('/api/run', async (req, res) => {
    if (jobState.state === 'running') {
        return res.status(409).json({ error: 'A run is already in progress.' });
    }
    if (process.env.LIS_ALLOW_WRITES === '1') {
        return res.status(400).json({ error: 'LIS_ALLOW_WRITES=1 — this tool refuses to start.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
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
        exitCode: null
    };

    setImmediate(() => {
        runLisNavBot({ ...body, startedAt })
            .then((r) => {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: r.exitCode !== 0 ? (r.result.errors && r.result.errors[0]) || 'Run failed' : null,
                    summary: buildSummary(r.result, { outMainPath: r.outMainPath, outPackagesPath: r.outPackagesPath }),
                    result: r.result,
                    outMainPath: r.outMainPath,
                    outPackagesPath: r.outPackagesPath,
                    exitCode: r.exitCode
                };
            })
            .catch((e) => {
                jobState = {
                    state: 'idle',
                    runId,
                    startedAt,
                    error: String(e && e.message ? e.message : e),
                    summary: null,
                    result: null,
                    outMainPath: null,
                    outPackagesPath: null,
                    exitCode: 1
                };
            });
    });

    res.json({ runId, startedAt });
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
