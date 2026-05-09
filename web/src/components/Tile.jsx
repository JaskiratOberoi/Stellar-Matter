import { aggregatePages, makeOtherTestsPinned, tileEnvelopes, topLabelFromTile } from '../lib/envelopes.js';
import { fmtDateRange, tileEyebrow } from '../lib/format.js';

function metricFor(kind, tile, clientPagesByNorm) {
    if (kind === 'citrate_vials') {
        const cv = tile.citrateVials || {};
        const btc = cv.byTestCode && typeof cv.byTestCode === 'object' ? cv.byTestCode : {};
        const codes = Object.keys(btc).sort();
        const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
        const subParts = codes.map((code) => {
            const row = btc[code] || { sids: 0, rows: 0 };
            return `${(row.sids || 0).toLocaleString('en-US')} ${code}`;
        });
        const subline = subParts.length
            ? `${subParts.join(' + ')} (${totalRows.toLocaleString('en-US')} tests)`
            : 'No assay breakdown';
        return {
            num: (cv.sidsTotal || 0).toLocaleString('en-US'),
            label: subline,
            estimated: false,
            estimatedLabel: null
        };
    }
    if (kind === 'edta_vials') {
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
            : 'No assay breakdown';
        return {
            num: (ev.sidsTotal || 0).toLocaleString('en-US'),
            label: subline,
            estimated: false,
            estimatedLabel: null
        };
    }
    if (kind === 'urine_containers') {
        // Tile data shape comes from buildTileFromRunFiles in server.js: a
        // urine-container artefact carries tile.urineContainers = { sidsTotal,
        // testCodes, byTestCode: { cp004: { sids, rows }, mb034: { sids, rows } } }.
        // Headline number = sidsTotal (= unique containers needed). Subline =
        // per-code breakdown so the lab can see which assay drove the count.
        const uc = tile.urineContainers || {};
        const cp = (uc.byTestCode && uc.byTestCode.cp004) || { sids: 0, rows: 0 };
        const mb = (uc.byTestCode && uc.byTestCode.mb034) || { sids: 0, rows: 0 };
        const totalRows = (cp.rows || 0) + (mb.rows || 0);
        return {
            num: (uc.sidsTotal || 0).toLocaleString('en-US'),
            label: (
                <>
                    {cp.sids.toLocaleString('en-US')}
                    {'\u2009CP004\u2009'}
                    <span className="muted">+</span>
                    {'\u2009'}
                    {mb.sids.toLocaleString('en-US')}
                    {'\u2009MB034\u2009'}
                    <span className="muted small">{`(${totalRows.toLocaleString('en-US')} tests)`}</span>
                </>
            ),
            estimated: false,
            estimatedLabel: null
        };
    }
    if (kind === 'envelopes') {
        const env = tileEnvelopes(tile, clientPagesByNorm);
        return {
            num: (
                <>
                    {env.big.toLocaleString('en-US')}
                    {'\u2009BIG\u2009'}
                    <span className="muted">/</span>
                    {'\u2009'}
                    {env.small.toLocaleString('en-US')}
                    {'\u2009SMALL'}
                </>
            ),
            label: `${env.total.toLocaleString('en-US')} total`,
            estimated: env.estimated,
            estimatedLabel: 'estimated envelopes'
        };
    }
    const rows = Array.isArray(tile.labelRows) ? tile.labelRows : [];
    const pinned = makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount);
    const agg = aggregatePages(rows, pinned, clientPagesByNorm);
    const top = topLabelFromTile(tile);
    return {
        num: agg.knownSum.toLocaleString('en-US'),
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
                <span className="tile-metric-num">{m.num}</span>
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
