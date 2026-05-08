import { normalizePackageLabel } from './format.js';

// Mirror of scripts/lis-nav-bot/public/app.js helpers, lifted verbatim so the
// per-package modal stays consistent with what the legacy UI rendered.

export function makeOtherTestsPinned(count) {
    const n = Math.floor(Number(count)) || 0;
    if (n < 1) return null;
    return { label: 'Other tests', count: n, pagesPerReport: 1, isOther: true };
}

export function rowsFromLabelOccurrences(occ) {
    if (!occ || typeof occ !== 'object') return [];
    return Object.entries(occ).map(([label, count]) => ({ label, count: Number(count) || 0 }));
}

export function resolvePagesPerReport(row, clientPagesByNorm) {
    if (row.isOther === true) return 1;
    if (row.pagesPerReport != null && Number.isFinite(Number(row.pagesPerReport))) return Number(row.pagesPerReport);
    if (row.totalPages != null && Number.isFinite(Number(row.totalPages))) return Number(row.totalPages);
    const n = clientPagesByNorm[normalizePackageLabel(row.label)];
    return Number.isFinite(n) ? n : null;
}

export function resolveTotalPagesProduct(row, clientPagesByNorm) {
    const ppr = resolvePagesPerReport(row, clientPagesByNorm);
    if (ppr == null) return null;
    return (Number(row.count) || 0) * ppr;
}

export function aggregatePages(bodyRows, pinnedRow, clientPagesByNorm) {
    let knownSum = 0;
    let unknownLabels = 0;
    const add = (row) => {
        const p = resolveTotalPagesProduct(row, clientPagesByNorm);
        if (p == null) unknownLabels++;
        else knownSum += p;
    };
    if (pinnedRow && Number(pinnedRow.count) > 0) add(pinnedRow);
    (bodyRows || []).forEach(add);
    return { knownSum, unknownLabels };
}

export function resolveEnvelopeKind(row, clientPagesByNorm) {
    if (row.envelopeKind === 'big' || row.envelopeKind === 'small') return row.envelopeKind;
    if (row.isOther) return 'small';
    const ppr = resolvePagesPerReport(row, clientPagesByNorm);
    if (ppr == null) return 'small';
    return ppr > 10 ? 'big' : 'small';
}

export function resolveEnvelopeEstimated(row, clientPagesByNorm) {
    if (typeof row.envelopeEstimated === 'boolean') return row.envelopeEstimated;
    if (row.isOther) return false;
    return resolvePagesPerReport(row, clientPagesByNorm) == null;
}

export function aggregateEnvelopes(bodyRows, pinnedRow, clientPagesByNorm) {
    let big = 0;
    let small = 0;
    let unknown = 0;
    const add = (row) => {
        const c = Number(row.count) || 0;
        if (resolveEnvelopeEstimated(row, clientPagesByNorm)) unknown += c;
        if (resolveEnvelopeKind(row, clientPagesByNorm) === 'big') big += c;
        else small += c;
    };
    if (pinnedRow && Number(pinnedRow.count) > 0) add(pinnedRow);
    (bodyRows || []).forEach(add);
    return { big, small, total: big + small, unknown, estimated: unknown > 0 };
}

export function tileEnvelopes(tile, clientPagesByNorm) {
    if (tile && tile.totals && tile.totals.envelopes && typeof tile.totals.envelopes.total === 'number') {
        return {
            big: Number(tile.totals.envelopes.big) || 0,
            small: Number(tile.totals.envelopes.small) || 0,
            total: Number(tile.totals.envelopes.total) || 0,
            estimated: !!tile.totals.envelopes.estimated
        };
    }
    const rows = Array.isArray(tile.labelRows) ? tile.labelRows : [];
    const pinned = makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount);
    return aggregateEnvelopes(rows, pinned, clientPagesByNorm);
}

export function topLabelFromTile(tile) {
    if (!tile || !Array.isArray(tile.labelRows)) return null;
    let best = null;
    for (const r of tile.labelRows) {
        if (!best || Number(r.count) > Number(best.count)) best = r;
    }
    return best;
}
