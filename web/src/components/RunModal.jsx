import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregateEnvelopes, aggregatePages, makeOtherTestsPinned } from '../lib/envelopes.js';
import { fmtDateRange, tileEyebrow } from '../lib/format.js';
import { PackagesTable } from './PackagesTable.jsx';

export function RunModal({ tile, kind, indexFromOne, clientPagesByNorm, onClose }) {
    const dialogRef = useRef(null);
    const [filter, setFilter] = useState('');
    const [shown, setShown] = useState({ visible: 0, total: 0 });

    const rows = useMemo(() => (Array.isArray(tile?.labelRows) ? tile.labelRows : []), [tile]);
    const pinned = useMemo(
        () => (tile ? makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount) : null),
        [tile]
    );

    useEffect(() => {
        if (!tile) return;
        setFilter('');
        const dlg = dialogRef.current;
        if (!dlg) return;
        if (typeof dlg.showModal === 'function') {
            try {
                dlg.showModal();
            } catch {
                dlg.setAttribute('open', '');
            }
        } else {
            dlg.setAttribute('open', '');
        }
        const onCancel = (e) => {
            e.preventDefault();
            onClose();
        };
        const onClick = (e) => {
            if (e.target === dlg) onClose();
        };
        dlg.addEventListener('cancel', onCancel);
        dlg.addEventListener('click', onClick);
        return () => {
            dlg.removeEventListener('cancel', onCancel);
            dlg.removeEventListener('click', onClick);
            try {
                if (typeof dlg.close === 'function') dlg.close();
                else dlg.removeAttribute('open');
            } catch {
                dlg.removeAttribute('open');
            }
        };
    }, [tile, onClose]);

    if (!tile) return null;

    const baseEyebrow = tileEyebrow(tile, indexFromOne);
    const kindBadge = kind === 'envelopes' ? 'ENVELOPES' : 'LETTER HEADS';
    const range = fmtDateRange(tile.fromDate, tile.toDate);
    const errs = (tile.totals && tile.totals.errors) || 0;
    const status = errs > 0 ? `${errs} error${errs === 1 ? '' : 's'}` : 'success';

    let totalLabel;
    let totalNum;
    let totalSub = null;
    let estChip = null;
    if (kind === 'envelopes') {
        const env = aggregateEnvelopes(rows, pinned, clientPagesByNorm);
        totalLabel = 'Total envelopes (big + small)';
        totalNum = env.total.toLocaleString('en-US');
        totalSub = `${env.big.toLocaleString('en-US')} BIG \u00b7 ${env.small.toLocaleString('en-US')} SMALL`;
        estChip = env.estimated ? 'estimated envelopes' : null;
    } else {
        const agg = aggregatePages(rows, pinned, clientPagesByNorm);
        totalLabel = 'Total printed pages';
        totalNum = agg.knownSum.toLocaleString('en-US');
        estChip = agg.unknownLabels > 0 ? 'estimated minimum' : null;
    }

    return (
        <dialog ref={dialogRef} className="run-modal">
            <div className="run-modal-inner nexus-card">
                <header className="run-modal-header row-between">
                    <div>
                        <p className="eyebrow">{`${baseEyebrow} \u00b7 ${kindBadge}`}</p>
                        <h2 className="run-modal-title">{String(tile.bu || '\u2014')}</h2>
                        <p className="muted small">{`${range} \u00b7 ${status}`}</p>
                    </div>
                    <button type="button" className="chip chip-tool" aria-label="Close" onClick={onClose}>
                        Close
                    </button>
                </header>
                <div className="run-modal-paths muted small path">
                    {tile.paths?.mainJson && <span>main: {tile.paths.mainJson}</span>}
                    {tile.paths?.mainJson && tile.paths?.packagesJson && ' \u00b7 '}
                    {tile.paths?.packagesJson && <span>packages: {tile.paths.packagesJson}</span>}
                </div>
                <div className="packages-toolbar modal-packages-toolbar">
                    <input
                        type="search"
                        placeholder="Filter labels…"
                        autoComplete="off"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                    />
                    <span className="muted small">
                        {shown.visible === shown.total
                            ? `${shown.total} label${shown.total === 1 ? '' : 's'}`
                            : `${shown.visible} of ${shown.total} labels`}
                    </span>
                </div>
                <div className="packages-table-host-modal table-wrap">
                    <PackagesTable
                        rows={rows}
                        pinned={pinned}
                        mode={kind === 'envelopes' ? 'envelopes' : 'pages'}
                        filter={filter}
                        clientPagesByNorm={clientPagesByNorm}
                        onCount={(visible, total) => setShown({ visible, total })}
                    />
                </div>
                <footer className="run-modal-footer row-between">
                    <span className="eyebrow-lite">{totalLabel}</span>
                    <div>
                        <span className="display-num">{totalNum}</span>
                        {totalSub && <span className="muted small modal-total-sub">{totalSub}</span>}
                        {estChip && <span className="estimated-chip-inline">{estChip}</span>}
                    </div>
                </footer>
            </div>
        </dialog>
    );
}
