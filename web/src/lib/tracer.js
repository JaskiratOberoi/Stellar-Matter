import { aggregatePages, makeOtherTestsPinned, tileEnvelopes } from './envelopes.js';

/** @param {object | null | undefined} tile */
export function projectLetterheads(tile, clientPagesByNorm) {
    if (!tile) return { headline: '—', subline: '', pages: null, estimated: false };
    const rows = Array.isArray(tile.labelRows) ? tile.labelRows : [];
    const pinned = makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount);
    const agg = aggregatePages(rows, pinned, clientPagesByNorm);
    const t = tile.totals || {};
    return {
        headline: agg.knownSum.toLocaleString('en-US'),
        subline: `${(t.uniqueLabels || 0).toLocaleString('en-US')} labels`,
        pages: agg.knownSum,
        estimated: agg.unknownLabels > 0
    };
}

/** @param {object | null | undefined} tile */
export function projectEnvelopes(tile, clientPagesByNorm) {
    if (!tile) return { headline: '—', subline: '', big: 0, small: 0, total: 0, estimated: false };
    const env = tileEnvelopes(tile, clientPagesByNorm);
    return {
        headline: `${env.big.toLocaleString('en-US')} BIG / ${env.small.toLocaleString('en-US')} SMALL`,
        subline: `${env.total.toLocaleString('en-US')} total`,
        big: env.big,
        small: env.small,
        total: env.total,
        estimated: env.estimated
    };
}

/** @param {object | null | undefined} tile */
export function projectUrineContainers(tile) {
    if (!tile) return { headline: '0', subline: '', sidsTotal: 0 };
    const uc = tile.urineContainers || {};
    const cp = (uc.byTestCode && uc.byTestCode.cp004) || { sids: 0, rows: 0 };
    const mb = (uc.byTestCode && uc.byTestCode.mb034) || { sids: 0, rows: 0 };
    const totalRows = (cp.rows || 0) + (mb.rows || 0);
    return {
        headline: (uc.sidsTotal || 0).toLocaleString('en-US'),
        subline: `${cp.sids.toLocaleString('en-US')} CP004 + ${mb.sids.toLocaleString('en-US')} MB034 (${totalRows.toLocaleString('en-US')} tests)`,
        sidsTotal: uc.sidsTotal || 0
    };
}

/** @param {object | null | undefined} tile */
export function projectEdtaVials(tile) {
    if (!tile) return { headline: '0', subline: '', sidsTotal: 0 };
    const ev = tile.edtaVials || {};
    const btc = ev.byTestCode && typeof ev.byTestCode === 'object' ? ev.byTestCode : {};
    const codes = Object.keys(btc).sort();
    const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
    const subParts = codes.map((code) => {
        const row = btc[code] || { sids: 0, rows: 0 };
        return `${(row.sids || 0).toLocaleString('en-US')} ${code}`;
    });
    const subline = subParts.length
        ? `${subParts.join(' + ')} (${totalRows.toLocaleString('en-US')} tests)`
        : 'No data';
    return {
        headline: (ev.sidsTotal || 0).toLocaleString('en-US'),
        subline,
        sidsTotal: ev.sidsTotal || 0
    };
}

/** @param {object | null | undefined} tile */
export function projectCitrateVials(tile) {
    return projectDedupBlob(tile && tile.citrateVials);
}

/** @param {object | null | undefined} tile */
export function projectSHeparin(tile) {
    return projectDedupBlob(tile && tile.sHeparin);
}

/** @param {object | null | undefined} tile */
export function projectLHeparin(tile) {
    return projectDedupBlob(tile && tile.lHeparin);
}

// Shared projection for any { sidsTotal, byTestCode } specialty blob.
function projectDedupBlob(blob) {
    if (!blob) return { headline: '0', subline: '', sidsTotal: 0 };
    const btc = blob.byTestCode && typeof blob.byTestCode === 'object' ? blob.byTestCode : {};
    const codes = Object.keys(btc).sort();
    const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
    const subParts = codes.map((code) => {
        const row = btc[code] || { sids: 0, rows: 0 };
        return `${(row.sids || 0).toLocaleString('en-US')} ${code}`;
    });
    const subline = subParts.length
        ? `${subParts.join(' + ')} (${totalRows.toLocaleString('en-US')} tests)`
        : 'No data';
    return {
        headline: (blob.sidsTotal || 0).toLocaleString('en-US'),
        subline,
        sidsTotal: blob.sidsTotal || 0
    };
}

/** Normalized key for merging Tracer banners (case- and trim-insensitive). */
export function tracerBuKey(bu) {
    return String(bu || '')
        .trim()
        .toLowerCase();
}

/** Stable React / print key for a region banner row. */
export function tracerRegionRowKey(kind, key) {
    return `region:${String(kind || '').toLowerCase()}:${String(key || '')
        .trim()
        .toUpperCase()}`;
}

function normRegionKey(key) {
    return String(key || '')
        .trim()
        .toUpperCase();
}

/**
 * Build `regions` body for `/api/tracer-run` + labels for banners.
 * @param {Array<{ key: string, label: string, cities?: { key: string, label: string }[] }>} treeStates
 * @param {Set<string>} selectedStates
 * @param {Set<string>} selectedCities
 */
export function buildRegionsSubmitPayload(treeStates, selectedStates, selectedCities) {
    const states = [];
    const cities = [];
    const bannerTargets = [];

    /** @type {Map<string, string>} */
    const stateLabelByKey = new Map();
    /** @type {Map<string, string>} */
    const cityLabelByKey = new Map();

    for (const st of treeStates || []) {
        stateLabelByKey.set(st.key, st.label);
        for (const c of st.cities || []) {
            cityLabelByKey.set(c.key, c.label);
        }
    }

    for (const sk of selectedStates) {
        const label = stateLabelByKey.get(sk) || sk;
        states.push({ key: sk, label });
        bannerTargets.push({ kind: 'state', key: sk, label });
    }
    for (const ck of selectedCities) {
        const label = cityLabelByKey.get(ck) || ck;
        cities.push({ key: ck, label });
        bannerTargets.push({ kind: 'city', key: ck, label });
    }

    return { regions: { states, cities }, bannerTargets };
}

/** @param {object | null | undefined} tile */
export function isRegionTile(tile) {
    if (!tile) return false;
    if (tile.kind === 'region') return true;
    if (tile.tracerScope === 'region') return true;
    return !!(tile.region && tile.region.key);
}

/** @param {object | null | undefined} tile */
export function isCollatedTile(tile) {
    if (!tile) return false;
    if (tile.kind === 'collated') return true;
    if (tile.tracerScope === 'collated') return true;
    return !!(tile.collated && (tile.collated.label || tile.collated.businessUnits));
}

function buEq(a, b) {
    return tracerBuKey(a) === tracerBuKey(b);
}

/**
 * Pick newest tiles from this batch per BU for general vs urine modes.
 * @param {object[]} tiles
 * @param {Set<string>} selectedBus
 * @param {string} batchStartedIso
 * @param {string} fromDate
 * @param {string} toDate
 */
export function mapTilesToBanners(tiles, selectedBus, batchStartedIso, fromDate, toDate) {
    const batchMs = (Date.parse(batchStartedIso) || 0) - 5000;
    const fd = String(fromDate || '').trim();
    const td = String(toDate || '').trim();

    /** @param {object} tile */
    const inBatch = (tile) => {
        const st = Date.parse(tile.startedAt);
        if (Number.isNaN(st) || st < batchMs) return false;
        if (fd && String(tile.fromDate || '').trim() !== fd) return false;
        if (td && String(tile.toDate || '').trim() !== td) return false;
        return true;
    };
    /** @param {object} tile */
    const modeOf = (tile) => {
        const m = tile.mode;
        if (m === 'urine_containers') return 'urine_containers';
        if (m === 'edta_vials') return 'edta_vials';
        if (m === 'citrate_vials') return 'citrate_vials';
        if (m === 's_heparin') return 's_heparin';
        if (m === 'l_heparin') return 'l_heparin';
        return 'general';
    };

    /** @param {string} bu */
    const pick = (bu, modeKey) => {
        const list = (tiles || []).filter(
            (t) =>
                !isRegionTile(t) &&
                !isCollatedTile(t) &&
                buEq(t.bu, bu) &&
                modeOf(t) === modeKey &&
                inBatch(t)
        );
        list.sort((a, b) => {
            const ta = Date.parse(a.startedAt) || 0;
            const tb = Date.parse(b.startedAt) || 0;
            return tb - ta;
        });
        return list[0] || null;
    };

    return [...selectedBus].map((bu) => ({
        bu,
        generalTile: pick(bu, 'general'),
        urineTile: pick(bu, 'urine_containers'),
        edtaTile: pick(bu, 'edta_vials'),
        citrateTile: pick(bu, 'citrate_vials'),
        sHeparinTile: pick(bu, 's_heparin'),
        lHeparinTile: pick(bu, 'l_heparin')
    }));
}

/**
 * Mirror mapTilesToBanners for geography-scoped tracer tiles.
 * @param {object[]} tiles
 * @param {{ kind: string, key: string, label: string }[]} regionTargets — from submit snapshot
 */
export function mapRegionTilesToBanners(tiles, regionTargets, batchStartedIso, fromDate, toDate) {
    const batchMs = (Date.parse(batchStartedIso) || 0) - 5000;
    const fd = String(fromDate || '').trim();
    const td = String(toDate || '').trim();

    /** @param {object} tile */
    const inBatch = (tile) => {
        const st = Date.parse(tile.startedAt);
        if (Number.isNaN(st) || st < batchMs) return false;
        if (fd && String(tile.fromDate || '').trim() !== fd) return false;
        if (td && String(tile.toDate || '').trim() !== td) return false;
        return true;
    };
    /** @param {object} tile */
    const modeOf = (tile) => {
        const m = tile.mode;
        if (m === 'urine_containers') return 'urine_containers';
        if (m === 'edta_vials') return 'edta_vials';
        if (m === 'citrate_vials') return 'citrate_vials';
        if (m === 's_heparin') return 's_heparin';
        if (m === 'l_heparin') return 'l_heparin';
        return 'general';
    };

    /** @param {object} tile */
    /** @param {{ kind: string, key: string }} targ */
    const matches = (tile, targ) => {
        if (!isRegionTile(tile)) return false;
        if (isCollatedTile(tile)) return false;
        const tr = tile.region;
        if (!tr || !tr.key) return false;
        return (
            String(tr.kind || '').toLowerCase() === String(targ.kind || '').toLowerCase() &&
            normRegionKey(tr.key) === normRegionKey(targ.key)
        );
    };

    /** @param {{ kind: string, key: string }} targ */
    /** @param {string} modeKey */
    const pick = (targ, modeKey) => {
        const list = (tiles || []).filter((t) => matches(t, targ) && modeOf(t) === modeKey && inBatch(t));
        list.sort((a, b) => {
            const ta = Date.parse(a.startedAt) || 0;
            const tb = Date.parse(b.startedAt) || 0;
            return tb - ta;
        });
        return list[0] || null;
    };

    return (regionTargets || []).map((targ) => ({
        bannerKey: tracerRegionRowKey(targ.kind, targ.key),
        label: targ.label || targ.key,
        kind: targ.kind,
        key: targ.key,
        generalTile: pick(targ, 'general'),
        urineTile: pick(targ, 'urine_containers'),
        edtaTile: pick(targ, 'edta_vials'),
        citrateTile: pick(targ, 'citrate_vials'),
        sHeparinTile: pick(targ, 's_heparin'),
        lHeparinTile: pick(targ, 'l_heparin')
    }));
}

/**
 * Pick the newest collated tiles from this batch for each tracer mode.
 * Returns a single banner row (or null if no collated artefacts exist yet)
 * shaped like the BU/region banners so <TracerBanner> can render unchanged.
 *
 * @param {object[]} tiles
 * @param {string} batchStartedIso
 * @param {string} fromDate
 * @param {string} toDate
 * @returns {null | { bannerKey: string, label: string, fromDate: string, toDate: string, generalTile: object|null, urineTile: object|null, edtaTile: object|null, citrateTile: object|null, sHeparinTile: object|null, lHeparinTile: object|null }}
 */
export function mapCollatedTileToBanner(tiles, batchStartedIso, fromDate, toDate) {
    const batchMs = (Date.parse(batchStartedIso) || 0) - 5000;
    const fd = String(fromDate || '').trim();
    const td = String(toDate || '').trim();

    /** @param {object} tile */
    const inBatch = (tile) => {
        const st = Date.parse(tile.startedAt);
        if (Number.isNaN(st) || st < batchMs) return false;
        if (fd && String(tile.fromDate || '').trim() !== fd) return false;
        if (td && String(tile.toDate || '').trim() !== td) return false;
        return true;
    };
    /** @param {object} tile */
    const modeOf = (tile) => {
        const m = tile.mode;
        if (m === 'urine_containers') return 'urine_containers';
        if (m === 'edta_vials') return 'edta_vials';
        if (m === 'citrate_vials') return 'citrate_vials';
        if (m === 's_heparin') return 's_heparin';
        if (m === 'l_heparin') return 'l_heparin';
        return 'general';
    };

    const candidates = (tiles || []).filter((t) => isCollatedTile(t) && inBatch(t));
    if (candidates.length === 0) return null;

    /** @param {string} modeKey */
    const pick = (modeKey) => {
        const list = candidates.filter((t) => modeOf(t) === modeKey);
        list.sort((a, b) => {
            const ta = Date.parse(a.startedAt) || 0;
            const tb = Date.parse(b.startedAt) || 0;
            return tb - ta;
        });
        return list[0] || null;
    };

    const generalTile = pick('general');
    const labelFromTile =
        (generalTile && generalTile.collated && generalTile.collated.label) || 'Collated';

    return {
        bannerKey: 'collated:run',
        label: labelFromTile,
        fromDate: fd,
        toDate: td,
        generalTile,
        urineTile: pick('urine_containers'),
        edtaTile: pick('edta_vials'),
        citrateTile: pick('citrate_vials'),
        sHeparinTile: pick('s_heparin'),
        lHeparinTile: pick('l_heparin')
    };
}

/**
 * Poll until server is not running a job.
 *
 * Default budget is 20 minutes per step. The Tracer chains six sequential
 * runs (general -> urine -> EDTA -> citrate -> S.Heparin -> L.Heparin) and
 * each can fan out across N business units * M test codes; for a multi-BU
 * full-month range the EDTA step alone can run several minutes against
 * Listec. The previous 3-minute cap caused the frontend to give up while
 * the server was still happily processing, leaving the run pill spinning
 * and the user staring at a misleading "timed out" error.
 *
 * If the budget is genuinely exceeded the thrown error makes it explicit
 * that the server may still be running so the user knows to refresh
 * rather than re-trigger and risk a queued duplicate.
 *
 * @param {() => Promise<Response>} fetchStatus
 */
export async function waitForRunIdle(fetchStatus, { maxWaitMs = 1200000, intervalMs = 2000 } = {}) {
    const start = Date.now();
    for (;;) {
        const r = await fetchStatus();
        const j = await r.json().catch(() => ({}));
        if (j && j.state !== 'running') return j;
        if (Date.now() - start > maxWaitMs) {
            throw new Error(
                `Run still in progress after ${Math.round(maxWaitMs / 60000)} minutes. The server is likely still processing — wait for the topbar pill to clear, then refresh the page to see results before starting another run.`
            );
        }
        await new Promise((res) => setTimeout(res, intervalMs));
    }
}
