import { useMemo, useState } from 'react';
import {
    aggregateEnvelopes,
    aggregatePages,
    resolveEnvelopeEstimated,
    resolveEnvelopeKind,
    resolveTotalPagesProduct
} from '../lib/envelopes.js';

/**
 * Sortable + filterable per-package table. Mode flips between
 * 'pages' (Letter Heads) and 'envelopes'.
 */
export function PackagesTable({ rows, pinned, mode = 'pages', filter = '', clientPagesByNorm }) {
    const isEnvelopes = mode === 'envelopes';
    const [sortKey, setSortKey] = useState('count');
    const [sortDir, setSortDir] = useState('desc');

    const sortedBody = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const rs = q ? rows.filter((r) => r.label.toLowerCase().includes(q)) : rows.slice();
        const dir = sortDir === 'asc' ? 1 : -1;
        const ascend = sortDir === 'asc';
        rs.sort((a, b) => {
            if (sortKey === 'label') return dir * a.label.localeCompare(b.label);
            if (sortKey === 'count') return dir * (a.count - b.count);
            if (sortKey === 'pages') {
                const pa = resolveTotalPagesProduct(a, clientPagesByNorm);
                const pb = resolveTotalPagesProduct(b, clientPagesByNorm);
                const va = pa != null ? pa : ascend ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
                const vb = pb != null ? pb : ascend ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
                return dir * (va - vb);
            }
            if (sortKey === 'envelope') {
                const ka = resolveEnvelopeKind(a, clientPagesByNorm);
                const kb = resolveEnvelopeKind(b, clientPagesByNorm);
                if (ka === kb) return dir * (a.count - b.count);
                return dir * (ka === 'big' ? -1 : 1);
            }
            return 0;
        });
        return rs;
    }, [rows, filter, sortKey, sortDir, clientPagesByNorm]);

    const hasPinned = !!(pinned && Number(pinned.count) > 0);

    if (!rows.length && !hasPinned) {
        return <div className="empty">No package labels in scrape results.</div>;
    }
    if (!sortedBody.length && !hasPinned) {
        return <div className="empty">No labels match this filter.</div>;
    }

    const lastColKey = isEnvelopes ? 'envelope' : 'pages';
    const lastColLabel = isEnvelopes ? 'Envelope' : 'Total Pages';
    const lastColExtra = isEnvelopes ? 'envelope' : 'pages';

    function clickHeader(k) {
        if (sortKey === k) setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
        else {
            setSortKey(k);
            setSortDir(k === 'label' ? 'asc' : 'desc');
        }
    }

    function HeaderCell({ k, label, extra }) {
        const cls = ['sortable'];
        if (sortKey === k) cls.push('sorted');
        if (extra) cls.push(extra);
        const arrow = sortKey === k ? (sortDir === 'asc' ? '\u25b2' : '\u25bc') : '';
        return (
            <th className={cls.join(' ')} onClick={() => clickHeader(k)}>
                {label}
                <span className="sort-arrow">{arrow}</span>
            </th>
        );
    }

    function lastCell(row) {
        if (isEnvelopes) {
            const kind = resolveEnvelopeKind(row, clientPagesByNorm);
            const est = resolveEnvelopeEstimated(row, clientPagesByNorm);
            return (
                <td className="envelope-cell">
                    <span className={`env-chip ${kind === 'big' ? 'env-big' : 'env-small'}`}>{kind.toUpperCase()}</span>
                    {est && <span className="muted small"> est.</span>}
                </td>
            );
        }
        const totalPagesProduct = resolveTotalPagesProduct(row, clientPagesByNorm);
        return totalPagesProduct != null ? (
            <td className="pages-num">{totalPagesProduct.toLocaleString('en-US')}</td>
        ) : (
            <td className="pages-cell">
                <span className="unknown-chip">unknown</span>
            </td>
        );
    }

    const rank1Candidate =
        sortedBody.length && sortKey === 'count' && sortDir === 'desc' && !filter.trim() ? sortedBody[0] : null;

    let footerLabel;
    let footerCellNode;
    let footerCls;
    if (isEnvelopes) {
        const env = aggregateEnvelopes(rows, hasPinned ? pinned : null, clientPagesByNorm);
        footerLabel = 'Total envelopes \u00b7 whole scan';
        footerCellNode = (
            <>
                {env.total.toLocaleString('en-US')}
                <span className="muted small env-split">
                    {env.big.toLocaleString('en-US')} BIG \u00b7 {env.small.toLocaleString('en-US')} SMALL
                </span>
                {env.estimated && <span className="muted estimated-chip-inline"> estimated</span>}
            </>
        );
        footerCls = `pages-num packages-tfoot-pages${env.estimated ? ' estimated-sum' : ''}`;
    } else {
        const { knownSum, unknownLabels } = aggregatePages(rows, hasPinned ? pinned : null, clientPagesByNorm);
        footerLabel = 'Total printed pages \u00b7 whole scan';
        footerCellNode = (
            <>
                {knownSum.toLocaleString('en-US')}
                {unknownLabels > 0 && (
                    <>
                        {' '}
                        <span className="muted">
                            {` (${unknownLabels} label${unknownLabels === 1 ? '' : 's'} unmapped — minimum)`}
                        </span>{' '}
                        <span className="muted estimated-chip-inline">estimated</span>
                    </>
                )}
            </>
        );
        footerCls = `pages-num packages-tfoot-pages${unknownLabels > 0 ? ' estimated-sum' : ''}`;
    }

    return (
        <table className="packages">
            <thead>
                <tr>
                    <th>#</th>
                    <HeaderCell k="label" label="Package label" />
                    <HeaderCell k="count" label="Count" extra="count" />
                    <HeaderCell k={lastColKey} label={lastColLabel} extra={lastColExtra} />
                </tr>
            </thead>
            <tbody>
                {hasPinned && (
                    <tr className="pinned-row">
                        <td className="rank rank-pinned">—</td>
                        <td className="label">{pinned.label}</td>
                        <td className="count">{pinned.count}</td>
                        {lastCell(pinned)}
                    </tr>
                )}
                {sortedBody.map((row, i) => (
                    <tr key={`${row.label}-${i}`} className={rank1Candidate && row === rank1Candidate ? 'rank-1' : ''}>
                        <td className="rank">{i + 1}</td>
                        <td className="label">{row.label}</td>
                        <td className="count">{row.count}</td>
                        {lastCell(row)}
                    </tr>
                ))}
            </tbody>
            <tfoot>
                <tr className="packages-tfoot-row">
                    <td colSpan={3} className="packages-tfoot-label">
                        {footerLabel}
                    </td>
                    <td className={footerCls}>{footerCellNode}</td>
                </tr>
            </tfoot>
        </table>
    );
}
