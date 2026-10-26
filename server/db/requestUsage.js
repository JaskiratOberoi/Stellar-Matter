'use strict';

// What a site actually used last month, so a material request can be read
// against it before it is approved.
//
// Two sources, both already in this database:
//   dispatches  inventory_movements kind='dispatch' to the site's
//               inventory_locations row, in base units — "what we sent them"
//   the Tracer  a general-mode run covering last month for the site's business
//               unit (runs.bu) or centre (runs.code_wise), which gives printed
//               letterhead pages, envelopes and sample counts per tube type —
//               "what they actually consumed"
//
// The baseline for a line is the Tracer figure when a run covers the month
// and the site, else the dispatched quantity. Requested quantities are read
// in base units (the catalogue unit, or packs × pack size) so the two compare.
//
// Months are calendar months in Asia/Kolkata, like the consumption view.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./pool');

const TZ = 'Asia/Kolkata';

// Tracer column → the catalogue material it is counted as (demandMap.js, by name).
const TRACER_MATERIALS = [
    { key: 'lh', name: 'Noble Letterhead', unit: 'page' },
    { key: 'envBig', name: 'Envelopes (Big)', unit: 'envelope' },
    { key: 'envSmall', name: 'Envelopes (Small)', unit: 'envelope' },
    { key: 'urineContainers', name: 'Urine Containers', unit: 'sample' },
    { key: 'edtaVials', name: 'EDTA Vials', unit: 'sample' },
    { key: 'flourideVials', name: 'Flouride Vials', unit: 'sample' },
    { key: 'citrateVials', name: 'Citrate Vials', unit: 'sample' },
    { key: 'sHeparin', name: 'S.Heparin', unit: 'sample' },
    { key: 'lHeparin', name: 'L.Heparin', unit: 'sample' },
    { key: 'lbc', name: 'LBC', unit: 'sample' },
    { key: 'barcode', name: 'Barcode Labels', unit: 'sample' },
    { key: 'serum', name: 'Serum Tubes', unit: 'sample' }
];
// Specialty modes live in their own runs rows (one per mode) under these columns.
const MODE_COLUMNS = {
    urineContainers: 'urine_containers', edtaVials: 'edta_vials', flourideVials: 'flouride_vials',
    citrateVials: 'citrate_vials', sHeparin: 's_heparin', lHeparin: 'l_heparin', lbc: 'lbc',
    barcode: 'barcode', serum: 'serum'
};

const norm = (s) => String(s || '').trim().toLowerCase();

// -- the month ----------------------------------------------------------------

function istParts(d = new Date()) {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
    const [y, m, day] = f.format(d).split('-').map(Number);
    return { y, m, day };
}

/** The previous calendar month (IST): its key, first and last day, and the UTC bounds for timestamps. */
function previousMonth(now = new Date()) {
    const { y, m } = istParts(now);
    const py = m === 1 ? y - 1 : y;
    const pm = m === 1 ? 12 : m - 1;
    const lastDay = new Date(Date.UTC(py, pm, 0)).getUTCDate();
    const key = `${py}-${String(pm).padStart(2, '0')}`;
    return {
        key,
        label: new Date(Date.UTC(py, pm - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
        firstDay: `${key}-01`,
        lastDay: `${key}-${String(lastDay).padStart(2, '0')}`,
        // IST midnight = 18:30 UTC the day before.
        startUtc: new Date(Date.UTC(py, pm - 1, 1, 0, 0, 0) - 330 * 60000),
        endUtc: new Date(Date.UTC(py, pm, 1, 0, 0, 0) - 330 * 60000)
    };
}

/** "01/09/2026", "01-09-2026" or "2026-09-01" → "2026-09-01". */
function isoDay(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    return null;
}

// -- sites --------------------------------------------------------------------

async function listSites(orgId) {
    const r = await getPool().query(
        `SELECT id, name, kind, bu_code, client_code
         FROM inventory_locations
         WHERE org_id = $1 AND active = true AND kind IN ('business_unit', 'lab')
         ORDER BY name`,
        [orgId]
    );
    return r.rows;
}

async function getSite(orgId, id) {
    if (!id) return null;
    const r = await getPool().query(
        `SELECT id, name, kind, bu_code, client_code FROM inventory_locations
         WHERE org_id = $1 AND id = $2 AND active = true AND kind IN ('business_unit', 'lab')`,
        [orgId, String(id)]
    );
    return r.rows[0] || null;
}

/**
 * The site an Infinity request belongs to: the centre's own location when one
 * is set up, else the business unit the centre reports to (client_locations),
 * else the user's own business unit. Null when nothing matches.
 */
async function resolveSiteForRequester(orgId, requester) {
    const pool = getPool();
    const r = requester || {};
    const sites = await listSites(orgId);
    const byClient = (code) => sites.find((s) => s.client_code && norm(s.client_code) === norm(code));
    const byUnit = (label) => sites.find((s) => (s.bu_code && norm(s.bu_code) === norm(label)) || norm(s.name) === norm(label));

    if (r.clientCode) {
        const own = byClient(r.clientCode);
        if (own) return own;
        // The centre's unit as the LIS mirror knows it; the mirror rarely
        // carries a unit code, so the centre's city is the usual match
        // (the sites are named after their city: AGRA, DEHRADUN, Bijnor).
        const cl = await pool.query(
            `SELECT business_unit_code, business_unit_name, city_label, city_raw
             FROM client_locations WHERE UPPER(code) = UPPER($1) LIMIT 1`,
            [String(r.clientCode)]
        );
        const row = cl.rows[0];
        if (row) {
            const bu = byUnit(row.business_unit_code) || byUnit(row.business_unit_name)
                || byUnit(row.city_label) || byUnit(row.city_raw);
            if (bu) return bu;
        }
    }
    if (r.city) {
        const bu = byUnit(r.city);
        if (bu) return bu;
    }
    if (r.businessUnit) {
        const bu = byUnit(r.businessUnit);
        if (bu) return bu;
    }
    return null;
}

// -- dispatches ---------------------------------------------------------------

async function dispatchedInWindow(orgId, locationId, win) {
    const r = await getPool().query(
        `SELECT mv.material_id, SUM(mv.qty_base)::bigint AS qty_base, COUNT(*)::int AS movements
         FROM inventory_movements mv
         WHERE mv.org_id = $1 AND mv.kind = 'dispatch' AND mv.voided_at IS NULL
           AND mv.to_location_id = $2
           AND mv.occurred_at >= $3 AND mv.occurred_at < $4
         GROUP BY mv.material_id`,
        [orgId, locationId, win.startUtc.toISOString(), win.endUtc.toISOString()]
    );
    const out = {};
    for (const row of r.rows) out[row.material_id] = { qty: Number(row.qty_base), movements: row.movements };
    return out;
}

// -- the Tracer ---------------------------------------------------------------

let pagesCache = null;
function pagesMap() {
    if (pagesCache) return pagesCache;
    const candidates = [
        process.env.LIS_PACKAGE_PAGES_FILE,
        path.resolve(__dirname, '..', '..', 'scripts', 'lis-nav-bot', 'data', 'package-pages.json'),
        path.resolve(process.cwd(), 'scripts', 'lis-nav-bot', 'data', 'package-pages.json')
    ].filter(Boolean);
    const out = {};
    for (const p of candidates) {
        try {
            if (!fs.existsSync(p)) continue;
            const j = JSON.parse(fs.readFileSync(p, 'utf8'));
            for (const [k, v] of Object.entries((j && j.pages) || {})) {
                const n = Number(v);
                if (Number.isFinite(n)) out[String(k).toUpperCase().replace(/\s+/g, ' ').trim()] = n;
            }
            break;
        } catch { /* next */ }
    }
    pagesCache = out;
    return out;
}

/** Pages and envelopes from a per-code labelOccurrences block, as the tile wall counts them. */
function pagesFromOccurrences(occ, otherRows) {
    const map = pagesMap();
    let pages = 0, big = 0, small = 0;
    for (const [label, count] of Object.entries(occ || {})) {
        const n = Number(count) || 0;
        const ppr = map[String(label).toUpperCase().replace(/\s+/g, ' ').trim()];
        if (ppr == null) { small += n; continue; }
        pages += n * ppr;
        if (ppr > 10) big += n; else small += n;
    }
    const other = Number(otherRows) || 0;
    pages += other;
    small += other;
    return { lh: pages, envBig: big, envSmall: small };
}

/**
 * The Tracer's figures for the site last month, when a general-mode run
 * covers the whole month for its business unit. A centre (client_code) is
 * read from that run's per-code block; a unit from the run's own totals and
 * its sibling specialty runs. Null when no run covers the month.
 */
async function tracerForSite(orgId, site, win, centreCode = null) {
    if (!site) return null;
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, bu, from_date, to_date, started_at, total_printed_pages, envelopes_big, envelopes_small, code_wise, filter
         FROM runs
         WHERE org_id = $1 AND mode = 'general' AND bu IS NOT NULL
         ORDER BY started_at DESC
         LIMIT 400`,
        [orgId]
    );
    const covering = r.rows.filter((row) => {
        const from = isoDay(row.from_date), to = isoDay(row.to_date);
        return from && to && from <= win.firstDay && to >= win.lastDay;
    });
    if (!covering.length) return null;

    const unitKeys = [site.bu_code, site.name].filter(Boolean).map(norm);
    const isUnitRun = (row) => unitKeys.includes(norm(row.bu));

    // A centre: its own block in a run for its unit (or any run that carries
    // the code). The code is the site's own, or the requester's when the
    // request was filed under the centre's unit.
    const code = site.client_code || centreCode;
    if (code) {
        for (const row of covering) {
            const codes = (row.code_wise && Array.isArray(row.code_wise.codes)) ? row.code_wise.codes : [];
            const block = codes.find((c) => c && c.code && norm(c.code) === norm(code));
            if (!block) continue;
            const pages = pagesFromOccurrences(block.labelOccurrences, block.otherTestsRowCount);
            const modes = block.modes || {};
            const figures = { ...pages };
            for (const key of Object.keys(MODE_COLUMNS)) figures[key] = Number(modes[key]) || 0;
            return { runId: row.id, scope: 'centre', bu: row.bu, from: isoDay(row.from_date), to: isoDay(row.to_date), figures };
        }
    }

    // A unit: the run's totals, plus its specialty siblings (same unit and window).
    const unitRun = covering.find(isUnitRun);
    if (!unitRun) return null;
    const figures = {
        lh: Number(unitRun.total_printed_pages) || 0,
        envBig: Number(unitRun.envelopes_big) || 0,
        envSmall: Number(unitRun.envelopes_small) || 0
    };
    const sib = await pool.query(
        `SELECT mode, urine_containers, edta_vials, flouride_vials, citrate_vials, s_heparin, l_heparin, lbc, barcode, serum
         FROM runs
         WHERE org_id = $1 AND mode <> 'general' AND bu = $2 AND from_date = $3 AND to_date = $4
         ORDER BY started_at DESC`,
        [orgId, unitRun.bu, unitRun.from_date, unitRun.to_date]
    );
    const seen = new Set();
    for (const row of sib.rows) {
        if (seen.has(row.mode)) continue;
        seen.add(row.mode);
        for (const [key, col] of Object.entries(MODE_COLUMNS)) {
            if (col !== row.mode) continue;
            const blob = row[col];
            figures[key] = Number(blob && blob.sidsTotal) || 0;
        }
    }
    return { runId: unitRun.id, scope: 'unit', bu: unitRun.bu, from: isoDay(unitRun.from_date), to: isoDay(unitRun.to_date), figures };
}

// -- the comparison -----------------------------------------------------------

/** A line's quantity in base units, or null when the unit cannot be read. */
function toBase(line, material) {
    const qty = Number(line.quantity);
    if (!Number.isFinite(qty) || qty <= 0) return null;
    if (!material) return null;
    const u = norm(line.unit);
    const base = norm(material.base_unit);
    if (!u || u === 'unit' || u === base || u === `${base}s`) return { base: qty, factor: 1 };
    const pack = norm(material.default_pack_label);
    const size = Number(material.default_pack_size);
    if (pack && (u === pack || u === `${pack}s` || u === `${pack}es`) && size > 0) return { base: qty * size, factor: size };
    return null;
}

/**
 * Every line of a request read against the site's last month. Lines that
 * cannot be compared (no site, a custom item, an unreadable unit) say so.
 */
async function usageForRequest(orgId, request, now = new Date()) {
    const win = previousMonth(now);
    const site = request.location_id ? await getSite(orgId, request.location_id) : null;
    const lines = request.lines || [];
    const ids = [...new Set(lines.map((l) => l.material_id).filter(Boolean))];
    const materials = {};
    if (ids.length) {
        const r = await getPool().query(
            `SELECT id, name, base_unit, default_pack_size, default_pack_label FROM inventory_materials WHERE org_id = $1 AND id = ANY($2::text[])`,
            [orgId, ids]
        );
        for (const m of r.rows) materials[m.id] = m;
    }
    const dispatched = site ? await dispatchedInWindow(orgId, site.id, win) : {};
    const centreCode = request.source_meta && request.source_meta.clientCode ? String(request.source_meta.clientCode) : null;
    let tracer = site ? await tracerForSite(orgId, site, win, centreCode) : null;
    // A centre filed under its unit's site: the unit's totals are not the
    // centre's usage, so without the centre's own block there is no baseline.
    const centreWithoutBlock = Boolean(centreCode && site && !site.client_code && (!tracer || tracer.scope !== 'centre'));
    if (centreWithoutBlock) tracer = null;
    const tracerByName = {};
    if (tracer) {
        for (const t of TRACER_MATERIALS) {
            if (tracer.figures[t.key] != null) tracerByName[norm(t.name)] = Number(tracer.figures[t.key]) || 0;
        }
    }

    let overLines = 0;
    const out = lines.map((line) => {
        const material = line.material_id ? materials[line.material_id] : null;
        const conv = toBase(line, material);
        const disp = material && dispatched[material.id] ? dispatched[material.id].qty : (site && material ? 0 : null);
        const tr = material && Object.prototype.hasOwnProperty.call(tracerByName, norm(material.name)) ? tracerByName[norm(material.name)] : null;
        const baselineSource = tr != null ? 'tracer' : (disp != null ? 'dispatched' : null);
        const baseline = tr != null ? tr : disp;
        const comparable = Boolean(site && material && conv && baseline != null && !centreWithoutBlock);
        const requestedBase = conv ? conv.base : null;
        const overBy = comparable && requestedBase > baseline ? requestedBase - baseline : 0;
        if (overBy > 0) overLines += 1;
        // The baseline in the line's own unit, rounded up to a whole pack when it is in packs.
        // Nothing used last month: nothing to trim to — the reviewer decides.
        const suggested = comparable && baseline > 0 ? (conv.factor > 1 ? Math.ceil(baseline / conv.factor) : baseline) : null;
        return {
            line_id: line.id,
            material_id: line.material_id,
            material_name: line.material_name,
            requested: Number(line.quantity),
            unit: line.unit,
            requested_base: requestedBase,
            base_unit: material ? material.base_unit : null,
            dispatched_last_month: disp,
            tracer_last_month: tr,
            baseline,
            baseline_source: baselineSource,
            comparable,
            reason: !site ? 'no_site' : !material ? 'custom_item' : !conv ? 'unit_unreadable' : centreWithoutBlock ? 'centre_no_history' : baseline == null ? 'no_history' : null,
            over_by: overBy,
            suggested_quantity: suggested
        };
    });

    return {
        request_id: request.id,
        month: { key: win.key, label: win.label, from: win.firstDay, to: win.lastDay },
        site: site ? { id: site.id, name: site.name, kind: site.kind, bu_code: site.bu_code, client_code: site.client_code } : null,
        tracer: tracer ? { run_id: tracer.runId, scope: tracer.scope, bu: tracer.bu, from: tracer.from, to: tracer.to, centre: tracer.scope === 'centre' ? (site.client_code || centreCode) : null } : null,
        centre_code: centreCode,
        centre_without_history: centreWithoutBlock,
        over_lines: overLines,
        lines: out
    };
}

module.exports = {
    TZ,
    TRACER_MATERIALS,
    previousMonth,
    isoDay,
    listSites,
    getSite,
    resolveSiteForRequester,
    dispatchedInWindow,
    tracerForSite,
    toBase,
    usageForRequest
};
