import { useEffect, useMemo, useRef, useState } from 'react';
import { aggregateEnvelopes, aggregatePages, makeOtherTestsPinned } from '../lib/envelopes.js';
import { fmtDateRange, tileEyebrow } from '../lib/format.js';
import { PackagesTable } from './PackagesTable.jsx';

export function RunModal({ tile, kind, indexFromOne, clientPagesByNorm, onClose }) {
    const dialogRef = useRef(null);
    const [filter, setFilter] = useState('');

    // Stash onClose in a ref so the open/close useEffect doesn't re-run every
    // time the parent passes a fresh arrow function. Without this, the parent's
    // tile-polling re-render gives us a new onClose reference, which triggers
    // effect cleanup → dlg.close() → re-open via dlg.showModal() — and showModal
    // resets the dialog's scroll to the top, defeating any user scroll.
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    const rows = useMemo(() => (Array.isArray(tile?.labelRows) ? tile.labelRows : []), [tile]);
    const pinned = useMemo(
        () => (tile ? makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount) : null),
        [tile]
    );

    // Derive visible/total counts here instead of letting PackagesTable phone them
    // back via an onCount callback. The previous setShown({...}) round-trip created
    // a new object every render, defeating React's bail-out and producing an
    // infinite re-render loop that froze the tab when the modal opened.
    const hasPinned = !!(pinned && Number(pinned.count) > 0);
    const totalSlots = rows.length + (hasPinned ? 1 : 0);
    const visibleCount = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const matched = q ? rows.filter((r) => r.label.toLowerCase().includes(q)).length : rows.length;
        return matched + (hasPinned ? 1 : 0);
    }, [rows, filter, hasPinned]);

    // Open / close the native <dialog> exactly once per tile identity. Depending
    // on tile?.id (a stable string) instead of the tile object reference means a
    // background tiles refresh that hands us a fresh-but-equivalent object will
    // NOT trigger close+reopen — so the user's scroll position is preserved.
    const tileId = tile?.id || null;
    useEffect(() => {
        if (!tileId) return;
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
            onCloseRef.current && onCloseRef.current();
        };
        const onClick = (e) => {
            if (e.target === dlg) onCloseRef.current && onCloseRef.current();
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
    }, [tileId]);

    if (!tile) return null;

    const baseEyebrow = tileEyebrow(tile, indexFromOne);
    const isUrine = kind === 'urine_containers';
    const kindBadge = isUrine ? 'URINE CONTAINERS' : kind === 'envelopes' ? 'ENVELOPES' : 'LETTER HEADS';
    const range = fmtDateRange(tile.fromDate, tile.toDate);
    const errs = (tile.totals && tile.totals.errors) || 0;
    const status = errs > 0 ? `${errs} error${errs === 1 ? '' : 's'}` : 'success';

    let totalLabel;
    let totalNum;
    let totalSub = null;
    let estChip = null;
    if (isUrine) {
        const uc = tile.urineContainers || {};
        totalLabel = 'Containers needed (unique SIDs)';
        totalNum = (uc.sidsTotal || 0).toLocaleString('en-US');
        const cp = (uc.byTestCode && uc.byTestCode.cp004) || { sids: 0 };
        const mb = (uc.byTestCode && uc.byTestCode.mb034) || { sids: 0 };
        totalSub = `${cp.sids.toLocaleString('en-US')} CP004 \u00b7 ${mb.sids.toLocaleString('en-US')} MB034`;
    } else if (kind === 'envelopes') {
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
                {isUrine ? (
                    <div className="packages-table-host-modal table-wrap">
                        <UrineBreakdownTable urineContainers={tile.urineContainers} />
                    </div>
                ) : (
                    <>
                        <div className="packages-toolbar modal-packages-toolbar">
                            <input
                                type="search"
                                placeholder="Filter labels…"
                                autoComplete="off"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                            />
                            <span className="muted small">
                                {visibleCount === totalSlots
                                    ? `${totalSlots} label${totalSlots === 1 ? '' : 's'}`
                                    : `${visibleCount} of ${totalSlots} labels`}
                            </span>
                        </div>
                        <div className="packages-table-host-modal table-wrap">
                            <PackagesTable
                                rows={rows}
                                pinned={pinned}
                                mode={kind === 'envelopes' ? 'envelopes' : 'pages'}
                                filter={filter}
                                clientPagesByNorm={clientPagesByNorm}
                            />
                        </div>
                    </>
                )}
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

/**
 * 3-row breakdown for urine container runs: per-test SID/row counts plus a
 * union footer (= containers needed). No filter or sort — only two test codes
 * are ever in scope so the long sortable PackagesTable is overkill.
 */
function UrineBreakdownTable({ urineContainers }) {
    const uc = urineContainers || {};
    const cp = (uc.byTestCode && uc.byTestCode.cp004) || { sids: 0, rows: 0 };
    const mb = (uc.byTestCode && uc.byTestCode.mb034) || { sids: 0, rows: 0 };
    const total = uc.sidsTotal || 0;
    return (
        <table className="urine-breakdown">
            <thead>
                <tr>
                    <th>Test code</th>
                    <th className="num">SIDs (patients)</th>
                    <th className="num">Rows (raw)</th>
                </tr>
            </thead>
            <tbody>
                <tr>
                    <td>cp004</td>
                    <td className="num">{cp.sids.toLocaleString('en-US')}</td>
                    <td className="num">{(cp.rows || 0).toLocaleString('en-US')}</td>
                </tr>
                <tr>
                    <td>mb034</td>
                    <td className="num">{mb.sids.toLocaleString('en-US')}</td>
                    <td className="num">{(mb.rows || 0).toLocaleString('en-US')}</td>
                </tr>
            </tbody>
            <tfoot>
                <tr>
                    <td>Union (cp004 OR mb034) — containers needed</td>
                    <td className="num">{total.toLocaleString('en-US')}</td>
                    <td className="num">{((cp.rows || 0) + (mb.rows || 0)).toLocaleString('en-US')}</td>
                </tr>
            </tfoot>
        </table>
    );
}
