import { aggregatePages, makeOtherTestsPinned, tileEnvelopes, topLabelFromTile } from '../lib/envelopes.js';
import { fmtDateRange, tileEyebrow } from '../lib/format.js';

function metricFor(kind, tile, clientPagesByNorm) {
    if (kind === 'envelopes') {
        const env = tileEnvelopes(tile, clientPagesByNorm);
        return {
            num: env.total,
            label: (
                <>
                    {env.big.toLocaleString('en-US')} BIG <span className="muted small">/</span>{' '}
                    {env.small.toLocaleString('en-US')} SMALL
                </>
            ),
            estimated: env.estimated,
            estimatedLabel: 'estimated envelopes'
        };
    }
    const rows = Array.isArray(tile.labelRows) ? tile.labelRows : [];
    const pinned = makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount);
    const agg = aggregatePages(rows, pinned, clientPagesByNorm);
    const top = topLabelFromTile(tile);
    return {
        num: agg.knownSum,
        label: top ? (
            <>
                {String(top.label).toUpperCase()}
                {top.count != null && (
                    <>
                        {' '}
                        <span className="muted small">{`\u00d7 ${top.count}`}</span>
                    </>
                )}
            </>
        ) : (
            <span className="muted small">no labels</span>
        ),
        estimated: agg.unknownLabels > 0,
        estimatedLabel: 'estimated minimum'
    };
}

export function Tile({ tile, kind, indexFromOne, clientPagesByNorm, onOpen }) {
    const eyebrow = tileEyebrow(tile, indexFromOne);
    const buLabel = String(tile.bu || '\u2014');
    const dateRange = fmtDateRange(tile.fromDate, tile.toDate);
    const m = metricFor(kind, tile, clientPagesByNorm);
    const t = tile.totals || {};
    const stats = [`${(t.sids || 0).toLocaleString('en-US')} SIDs`, `${(t.uniqueLabels || 0).toLocaleString('en-US')} labels`, `${(t.occurrences || 0).toLocaleString('en-US')} occ.`];
    if ((t.errors || 0) > 0) stats.push(`${t.errors} errors`);

    return (
        <button type="button" className={`tile tile-${kind}`} onClick={() => onOpen(tile, kind)}>
            <span className="tile-eyebrow">{eyebrow}</span>
            <h3 className="tile-title">{buLabel}</h3>
            <p className="tile-sub">{dateRange}</p>
            <div className="tile-metric-row">
                <span className="tile-metric-num">{m.num.toLocaleString('en-US')}</span>
                <span className="tile-metric-label">{m.label}</span>
            </div>
            <p className="tile-stats">{stats.join(' \u00b7 ')}</p>
            <div className="tile-footer">
                <span className="tile-cta">{'view breakdown \u2192'}</span>
                {m.estimated ? <span className="tile-est">{m.estimatedLabel}</span> : <span />}
            </div>
        </button>
    );
}
