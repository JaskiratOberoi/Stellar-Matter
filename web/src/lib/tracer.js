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

function buEq(a, b) {
    return (
        String(a || '')
            .trim()
            .toLowerCase() ===
        String(b || '')
            .trim()
            .toLowerCase()
    );
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
    const modeOf = (tile) => (tile.mode === 'urine_containers' ? 'urine_containers' : 'general');

    /** @param {string} bu */
    const pick = (bu, mode) => {
        const list = (tiles || []).filter((t) => buEq(t.bu, bu) && modeOf(t) === mode && inBatch(t));
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
        urineTile: pick(bu, 'urine_containers')
    }));
}

/**
 * Poll until server is not running a job.
 * @param {() => Promise<Response>} fetchStatus
 */
export async function waitForRunIdle(fetchStatus, { maxWaitMs = 180000, intervalMs = 1500 } = {}) {
    const start = Date.now();
    for (;;) {
        const r = await fetchStatus();
        const j = await r.json().catch(() => ({}));
        if (j && j.state !== 'running') return j;
        if (Date.now() - start > maxWaitMs) {
            throw new Error('Run timed out waiting for server to go idle.');
        }
        await new Promise((res) => setTimeout(res, intervalMs));
    }
}
