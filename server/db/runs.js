'use strict';

// Phase 8: runs Postgres ingest + read layer.
//
// On-disk JSON files in `outDir` (out/run-<id>.json + out/run-<id>-packages.json)
// remain the canonical artefact. This module is the bridge between those files
// and the `runs` / `run_packages` tables — every shape it writes can be fully
// reconstructed from disk, so dropping the tables and re-running migrate +
// backfillFromDisk() yields the same dashboard.

const fs = require('fs');
const path = require('path');
const { getPool, useDatabase } = require('./pool');

/** Pull the package-pages map (label → pages-per-report). Loaded lazily because
 * the file lives in scripts/lis-nav-bot/data/ and the relative path from this
 * file changes when we reorganise. We keep the same lookup shape buildTile uses.
 */
function readPackagePagesMap() {
    const candidates = [
        process.env.LIS_PACKAGE_PAGES_FILE,
        path.resolve(__dirname, '..', '..', 'scripts', 'lis-nav-bot', 'data', 'package-pages.json'),
        path.resolve(process.cwd(), 'scripts', 'lis-nav-bot', 'data', 'package-pages.json')
    ].filter(Boolean);
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const raw = fs.readFileSync(p, 'utf8');
            const j = JSON.parse(raw);
            const pages = (j && typeof j === 'object' && j.pages && typeof j.pages === 'object' && j.pages) || {};
            const normalized = {};
            for (const [k, v] of Object.entries(pages)) {
                const num = Number(v);
                if (!Number.isFinite(num)) continue;
                normalized[normalizePackageLabel(k)] = num;
            }
            return normalized;
        } catch {
            // try next candidate
        }
    }
    return {};
}

function normalizePackageLabel(s) {
    return String(s || '')
        .toUpperCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** Build the full tile shape from on-disk run-<id>.json + run-<id>-packages.json.
 * This mirrors buildTileFromRunFiles() in scripts/lis-nav-bot/server.js so the
 * Postgres-backed and disk-backed code paths return identical JSON.
 */
function readRunArtifacts(outDir, id) {
    const mainPath = path.join(outDir, `run-${id}.json`);
    const pkgPath = path.join(outDir, `run-${id}-packages.json`);
    if (!fs.existsSync(pkgPath)) return null;
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
    return { main, pkg, mainPath, pkgPath };
}

/** Compute the canonical shape for ingest. Pure function — no I/O beyond the
 * caller-provided pages map. Returns null when the pkg blob is malformed.
 */
function projectRun(id, { main, pkg, mainPath, pkgPath }, normalizedMap) {
    const occ = (pkg && pkg.labelOccurrences && typeof pkg.labelOccurrences === 'object' && pkg.labelOccurrences) || {};
    const otherN =
        pkg && pkg.otherTestsRowCount != null && Number.isFinite(Number(pkg.otherTestsRowCount))
            ? Math.max(0, Math.floor(Number(pkg.otherTestsRowCount)))
            : 0;

    const labelRows = Object.entries(occ)
        .map(([label, count]) => {
            const norm = normalizePackageLabel(label);
            const ppr = normalizedMap[norm];
            const pprNum = ppr != null && Number.isFinite(Number(ppr)) ? Number(ppr) : null;
            return {
                label: String(label),
                count: Number(count) || 0,
                pagesPerReport: pprNum,
                envelopeKind: pprNum == null ? 'small' : pprNum > 10 ? 'big' : 'small',
                envelopeEstimated: pprNum == null
            };
        })
        .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    let knownSum = 0;
    for (const r of labelRows) {
        if (r.pagesPerReport != null) knownSum += r.count * r.pagesPerReport;
    }
    knownSum += otherN; // Other Tests is always 1 page each in the canonical dashboard

    const envelopes = { big: 0, small: 0, unknown: 0 };
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
    if (otherN > 0) envelopes.small += otherN;

    const filter = (pkg.filter && typeof pkg.filter === 'object' && pkg.filter) || {};
    const req = (main && main.filtersRequested && typeof main.filtersRequested === 'object' && main.filtersRequested) || {};
    const filtersApplied = (main && main.filtersApplied) || (pkg.filtersApplied && typeof pkg.filtersApplied === 'object' ? pkg.filtersApplied : null);
    const filtRegion =
        filter.region && typeof filter.region === 'object' && String(filter.region.key || '').trim() ? filter.region : null;
    const reqRegion =
        req.region && typeof req.region === 'object' && String(req.region.key || '').trim() ? req.region : null;
    const regionObj =
        filtRegion || reqRegion
            ? {
                  kind: String((filtRegion || reqRegion).kind || '').trim(),
                  key: String((filtRegion || reqRegion).key || '').trim(),
                  label:
                      String((filtRegion || reqRegion).label || (filtRegion || reqRegion).key || '').trim() ||
                      String((filtRegion || reqRegion).key || '').trim()
              }
            : null;
    let tracerScopeNorm =
        String(filter.tracerScope || '').trim().toLowerCase() ||
        String(req.tracerScope || '').trim().toLowerCase() ||
        '';
    if (tracerScopeNorm !== 'region' && regionObj) tracerScopeNorm = 'region';
    if (!tracerScopeNorm || tracerScopeNorm === 'bu') tracerScopeNorm = regionObj ? 'region' : 'bu';
    let bu =
        (filter.bu != null && String(filter.bu).trim()) ||
        (req.bu != null && String(req.bu).trim()) ||
        null;
    if ((!bu || String(bu).trim() === '') && tracerScopeNorm === 'region' && regionObj) {
        bu = regionObj.label || regionObj.key;
    }
    const source = (main && main.source) || (pkg && pkg.source) || 'scrape';
    const mode =
        (main && main.mode === 'urine_containers' && 'urine_containers') ||
        (pkg && pkg.mode === 'urine_containers' && 'urine_containers') ||
        (main && main.mode === 'edta_vials' && 'edta_vials') ||
        (pkg && pkg.mode === 'edta_vials' && 'edta_vials') ||
        (main && main.mode === 'citrate_vials' && 'citrate_vials') ||
        (pkg && pkg.mode === 'citrate_vials' && 'citrate_vials') ||
        (main && main.mode === 's_heparin' && 's_heparin') ||
        (pkg && pkg.mode === 's_heparin' && 's_heparin') ||
        (main && main.mode === 'l_heparin' && 'l_heparin') ||
        (pkg && pkg.mode === 'l_heparin' && 'l_heparin') ||
        'general';
    const urineContainers =
        mode === 'urine_containers'
            ? (main && main.urineContainers) ||
              (pkg && pkg.urineContainers && typeof pkg.urineContainers === 'object' ? pkg.urineContainers : null)
            : null;
    const edtaVials =
        mode === 'edta_vials'
            ? (main && main.edtaVials) || (pkg && pkg.edtaVials && typeof pkg.edtaVials === 'object' ? pkg.edtaVials : null)
            : null;
    const citrateVials =
        mode === 'citrate_vials'
            ? (main && main.citrateVials) || (pkg && pkg.citrateVials && typeof pkg.citrateVials === 'object' ? pkg.citrateVials : null)
            : null;
    const sHeparin =
        mode === 's_heparin'
            ? (main && main.sHeparin) || (pkg && pkg.sHeparin && typeof pkg.sHeparin === 'object' ? pkg.sHeparin : null)
            : null;
    const lHeparin =
        mode === 'l_heparin'
            ? (main && main.lHeparin) || (pkg && pkg.lHeparin && typeof pkg.lHeparin === 'object' ? pkg.lHeparin : null)
            : null;
    const orgId = String(
        (main && main.org_id != null && main.org_id) ||
            (pkg && pkg.org_id != null && pkg.org_id) ||
            'org-default'
    );
    const startedAt = (main && main.startedAt) || (pkg && pkg.startedAt) || null;
    const sidsCount = main && Array.isArray(main.sidsFoundOnPage1) ? main.sidsFoundOnPage1.length : 0;
    const errorsCount = main && Array.isArray(main.errors) ? main.errors.length : 0;
    const uniqueLabels =
        pkg && pkg.uniqueLabelCount != null && Number.isFinite(Number(pkg.uniqueLabelCount))
            ? Number(pkg.uniqueLabelCount)
            : labelRows.length + (otherN > 0 ? 1 : 0);

    const fromHour = numericOrNull(filter.fromHour, req.fromHour);
    const toHour = numericOrNull(filter.toHour, req.toHour);

    return {
        id,
        orgId,
        startedAt,
        finishedAt: null,
        source: String(source || 'scrape'),
        mode,
        bu: bu || null,
        fromDate: filter.fromDate != null ? String(filter.fromDate) : req.fromDate != null ? String(req.fromDate) : null,
        toDate: filter.toDate != null ? String(filter.toDate) : req.toDate != null ? String(req.toDate) : null,
        fromHour,
        toHour,
        dryRun: !!(main && main.dryRun),
        exitCode: null, // server tracks live exit_code via jobState; we don't persist it in the artifact
        sidsCount,
        errorsCount,
        uniqueLabelCount: uniqueLabels,
        otherTestsRowCount: otherN,
        totalPrintedPages: knownSum,
        envelopesBig: envelopes.big,
        envelopesSmall: envelopes.small,
        envelopesUnknown: envelopes.unknown,
        urineContainers,
        edtaVials,
        citrateVials,
        sHeparin,
        lHeparin,
        filter,
        filtersApplied,
        filtersRequested: req,
        paths: {
            mainJson: fs.existsSync(mainPath) ? mainPath : null,
            packagesJson: pkgPath
        },
        labelRows
    };
}

function numericOrNull(...candidates) {
    for (const v of candidates) {
        if (v == null || v === '') continue;
        const n = Number(v);
        if (Number.isFinite(n)) return Math.trunc(n);
    }
    return null;
}

/** UPSERT a single run + its packages from the on-disk artifacts. Returns
 * { ingested: bool, reason?: string } so callers can log what happened.
 */
async function ingestRun(client, outDir, id, opts = {}) {
    const artifacts = readRunArtifacts(outDir, id);
    if (!artifacts) return { ingested: false, reason: 'no-packages-file' };

    const normalizedMap = opts.normalizedMap || readPackagePagesMap();
    const projected = projectRun(id, artifacts, normalizedMap);
    if (!projected) return { ingested: false, reason: 'projection-failed' };

    let mtime = null;
    try {
        mtime = fs.statSync(artifacts.pkgPath).mtime.toISOString();
    } catch {
        mtime = null;
    }

    // We don't reach into runs.org_id without an FK target, so make sure the
    // org row exists. 99% of the time it's 'org-default' which migrate() seeds,
    // but bots may stamp other ids. Insert with a derived slug/name; ON CONFLICT
    // DO NOTHING preserves whatever an admin already set.
    if (projected.orgId && projected.orgId !== 'org-default') {
        await client.query(
            `INSERT INTO organizations (id, slug, name)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [projected.orgId, projected.orgId, projected.orgId]
        );
    }

    await client.query(
        `INSERT INTO runs (
            id, org_id, started_at, finished_at, source, mode, bu,
            from_date, to_date, from_hour, to_hour, dry_run, exit_code,
            errors_count, sids_count, unique_label_count, other_tests_row_count,
            total_printed_pages, envelopes_big, envelopes_small, envelopes_unknown,
            urine_containers, edta_vials, citrate_vials, s_heparin, l_heparin,
            filter, filters_applied, filters_requested, paths,
            source_file_mtime
         )
         VALUES (
            $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17,
            $18, $19, $20, $21,
            $22, $23, $24, $25, $26,
            $27, $28, $29, $30,
            $31
         )
         ON CONFLICT (id) DO UPDATE SET
            org_id = EXCLUDED.org_id,
            started_at = EXCLUDED.started_at,
            finished_at = EXCLUDED.finished_at,
            source = EXCLUDED.source,
            mode = EXCLUDED.mode,
            bu = EXCLUDED.bu,
            from_date = EXCLUDED.from_date,
            to_date = EXCLUDED.to_date,
            from_hour = EXCLUDED.from_hour,
            to_hour = EXCLUDED.to_hour,
            dry_run = EXCLUDED.dry_run,
            exit_code = EXCLUDED.exit_code,
            errors_count = EXCLUDED.errors_count,
            sids_count = EXCLUDED.sids_count,
            unique_label_count = EXCLUDED.unique_label_count,
            other_tests_row_count = EXCLUDED.other_tests_row_count,
            total_printed_pages = EXCLUDED.total_printed_pages,
            envelopes_big = EXCLUDED.envelopes_big,
            envelopes_small = EXCLUDED.envelopes_small,
            envelopes_unknown = EXCLUDED.envelopes_unknown,
            urine_containers = EXCLUDED.urine_containers,
            edta_vials = EXCLUDED.edta_vials,
            citrate_vials = EXCLUDED.citrate_vials,
            s_heparin = EXCLUDED.s_heparin,
            l_heparin = EXCLUDED.l_heparin,
            filter = EXCLUDED.filter,
            filters_applied = EXCLUDED.filters_applied,
            filters_requested = EXCLUDED.filters_requested,
            paths = EXCLUDED.paths,
            source_file_mtime = EXCLUDED.source_file_mtime`,
        [
            projected.id,
            projected.orgId,
            projected.startedAt,
            projected.finishedAt,
            projected.source,
            projected.mode,
            projected.bu,
            projected.fromDate,
            projected.toDate,
            projected.fromHour,
            projected.toHour,
            projected.dryRun,
            projected.exitCode,
            projected.errorsCount,
            projected.sidsCount,
            projected.uniqueLabelCount,
            projected.otherTestsRowCount,
            projected.totalPrintedPages,
            projected.envelopesBig,
            projected.envelopesSmall,
            projected.envelopesUnknown,
            projected.urineContainers ? JSON.stringify(projected.urineContainers) : null,
            projected.edtaVials ? JSON.stringify(projected.edtaVials) : null,
            projected.citrateVials ? JSON.stringify(projected.citrateVials) : null,
            projected.sHeparin ? JSON.stringify(projected.sHeparin) : null,
            projected.lHeparin ? JSON.stringify(projected.lHeparin) : null,
            JSON.stringify(projected.filter || {}),
            projected.filtersApplied ? JSON.stringify(projected.filtersApplied) : null,
            JSON.stringify(projected.filtersRequested || {}),
            JSON.stringify(projected.paths),
            mtime
        ]
    );

    // Replace the package set rather than diff'ing — runs are append-only in
    // practice, and the package list is small (~20 labels). DELETE + INSERT
    // is the simplest correct shape and avoids stale rows when a label is
    // dropped from a re-ingested artifact.
    await client.query(`DELETE FROM run_packages WHERE run_id = $1`, [projected.id]);
    if (projected.labelRows.length > 0) {
        const values = [];
        const placeholders = [];
        let p = 0;
        projected.labelRows.forEach((r, idx) => {
            placeholders.push(
                `($${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p}, $${++p})`
            );
            values.push(
                projected.id,
                r.label,
                r.count,
                r.pagesPerReport,
                r.envelopeKind,
                r.envelopeEstimated,
                idx
            );
        });
        await client.query(
            `INSERT INTO run_packages
                (run_id, label, count, pages_per_report, envelope_kind, envelope_estimated, position)
             VALUES ${placeholders.join(', ')}`,
            values
        );
    }

    return { ingested: true };
}

/** Walk outDir, ingest every run-*-packages.json that isn't already in the
 * runs table or whose source_file_mtime is older than the on-disk file.
 * Designed to run at server boot — it's idempotent and skips work when the
 * DB is already up to date.
 */
async function backfillFromDisk(outDir, opts = {}) {
    if (!useDatabase()) return { ingested: 0, skipped: 0, errors: [] };
    if (!fs.existsSync(outDir)) return { ingested: 0, skipped: 0, errors: [] };

    const pool = getPool();
    const client = await pool.connect();
    const out = { ingested: 0, skipped: 0, errors: [] };
    try {
        const existing = await client.query(`SELECT id, source_file_mtime FROM runs`);
        /** @type {Map<string, Date|null>} */
        const known = new Map();
        for (const r of existing.rows) {
            known.set(r.id, r.source_file_mtime ? new Date(r.source_file_mtime) : null);
        }

        const normalizedMap = readPackagePagesMap();
        const names = fs.readdirSync(outDir);
        for (const name of names) {
            const m = /^run-(.+)-packages\.json$/i.exec(name);
            if (!m) continue;
            if (name.includes('-error')) continue;
            const id = m[1];
            const full = path.join(outDir, name);
            let st;
            try {
                st = fs.statSync(full);
            } catch {
                continue;
            }
            const knownMtime = known.get(id);
            if (knownMtime && knownMtime.getTime() >= st.mtime.getTime()) {
                out.skipped += 1;
                continue;
            }
            try {
                const r = await ingestRun(client, outDir, id, { normalizedMap });
                if (r.ingested) out.ingested += 1;
                else out.skipped += 1;
            } catch (e) {
                out.errors.push({ id, error: String(e && e.message ? e.message : e) });
            }
        }
    } finally {
        client.release();
    }
    if (opts.verbose !== false) {
        console.log(
            `[stellar-matter] runs backfill: ingested=${out.ingested} skipped=${out.skipped} errors=${out.errors.length}`
        );
        if (out.errors.length > 0 && out.errors.length <= 5) {
            for (const e of out.errors) console.warn(`  - ${e.id}: ${e.error}`);
        }
    }
    return out;
}

/** Read tiles from Postgres for the dashboard. Mirrors the JSON shape the
 * disk-backed buildTileFromRunFiles() returns so the React tile wall doesn't
 * need to care which path served it.
 */
async function listTiles(opts = {}) {
    if (!useDatabase()) return null;
    const { orgId = null, allOrgs = false, limit = 500 } = opts;
    const pool = getPool();
    const client = await pool.connect();
    try {
        const params = [];
        let where = '';
        if (orgId && !allOrgs) {
            params.push(orgId);
            where = `WHERE r.org_id = $${params.length}`;
        }
        params.push(limit);
        const runsRes = await client.query(
            `SELECT * FROM runs r
             ${where}
             ORDER BY started_at DESC NULLS LAST, ingested_at DESC
             LIMIT $${params.length}`,
            params
        );
        if (runsRes.rows.length === 0) return [];
        const ids = runsRes.rows.map((r) => r.id);
        const pkgsRes = await client.query(
            `SELECT run_id, label, count, pages_per_report, envelope_kind, envelope_estimated, position
             FROM run_packages
             WHERE run_id = ANY($1::text[])
             ORDER BY run_id, position`,
            [ids]
        );
        /** @type {Map<string, any[]>} */
        const byRun = new Map();
        for (const p of pkgsRes.rows) {
            if (!byRun.has(p.run_id)) byRun.set(p.run_id, []);
            byRun.get(p.run_id).push({
                label: p.label,
                count: p.count,
                pagesPerReport: p.pages_per_report,
                envelopeKind: p.envelope_kind,
                envelopeEstimated: p.envelope_estimated
            });
        }
        return runsRes.rows.map((r) => tileFromRow(r, byRun.get(r.id) || []));
    } finally {
        client.release();
    }
}

function tileFromRow(r, labelRows) {
    const filt =
        typeof r.filter === 'object' && r.filter !== null && !Array.isArray(r.filter)
            ? r.filter
            : {};
    const filtRegion =
        filt.region && typeof filt.region === 'object' && String(filt.region.key || '').trim() ? filt.region : null;
    let tracerScopeFromFilter = String(filt.tracerScope || '').trim().toLowerCase();
    if (tracerScopeFromFilter !== 'region' && filtRegion) tracerScopeFromFilter = 'region';
    if (!tracerScopeFromFilter || tracerScopeFromFilter === 'bu') tracerScopeFromFilter = filtRegion ? 'region' : 'bu';
    const kind = tracerScopeFromFilter === 'region' ? 'region' : 'bu';
    const region =
        filtRegion
            ? {
                  kind: String(filtRegion.kind || '').trim(),
                  key: String(filtRegion.key || '').trim(),
                  label: String(filtRegion.label || filtRegion.key || '').trim()
              }
            : null;
    const tracerScope = kind === 'region' ? 'region' : 'bu';
    const occurrences = labelRows.reduce((s, x) => s + (Number(x.count) || 0), 0) + (r.other_tests_row_count || 0);
    return {
        id: r.id,
        startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
        tracerScope,
        kind,
        region,
        source: r.source,
        mode: r.mode,
        urineContainers: r.urine_containers || null,
        edtaVials: r.edta_vials || null,
        citrateVials: r.citrate_vials || null,
        sHeparin: r.s_heparin || null,
        lHeparin: r.l_heparin || null,
        orgId: r.org_id,
        bu: r.bu || '—',
        fromDate: r.from_date,
        toDate: r.to_date,
        fromHour: r.from_hour,
        toHour: r.to_hour,
        totals: {
            totalPrintedPages: r.total_printed_pages,
            estimated: (r.envelopes_unknown || 0) > 0,
            sids: r.sids_count,
            occurrences,
            uniqueLabels: r.unique_label_count,
            otherTestsRowCount: r.other_tests_row_count,
            errors: r.errors_count,
            envelopes: {
                big: r.envelopes_big,
                small: r.envelopes_small,
                total: (r.envelopes_big || 0) + (r.envelopes_small || 0),
                estimated: (r.envelopes_unknown || 0) > 0
            }
        },
        paths: r.paths || { mainJson: null, packagesJson: null },
        labelRows: labelRows.slice(0, 50),
        labelRowCount: labelRows.length,
        filtersApplied: r.filters_applied || null
    };
}

/** Convenience wrapper used by server.js post-run hooks. Opens its own
 * client and swallows errors (logging them) so a Postgres outage never
 * blocks a successful disk write from completing.
 */
async function ingestRunSafe(outDir, id) {
    if (!useDatabase()) return { ingested: false, reason: 'db-disabled' };
    let client;
    try {
        client = await getPool().connect();
    } catch (e) {
        console.warn(`[stellar-matter] runs.ingestRunSafe: pool connect failed: ${e.message}`);
        return { ingested: false, reason: 'pool-error', error: String(e.message || e) };
    }
    try {
        return await ingestRun(client, outDir, id);
    } catch (e) {
        console.warn(`[stellar-matter] runs.ingestRunSafe(${id}) failed: ${e.message}`);
        return { ingested: false, reason: 'ingest-error', error: String(e.message || e) };
    } finally {
        client.release();
    }
}

module.exports = {
    ingestRun,
    ingestRunSafe,
    backfillFromDisk,
    listTiles,
    tileFromRow,
    projectRun,
    readRunArtifacts,
    readPackagePagesMap
};
