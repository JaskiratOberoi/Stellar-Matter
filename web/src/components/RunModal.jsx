import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

    // Open / close the native <dialog> once per stable run identity. Never use
    // `tile?.id || null` (valid ids like 0 would suppress open). Portaled to
    // document.body so ancestor overflow (e.g. .main-pane) cannot trap the modal.
    const modalOpenKey = useMemo(() => {
        if (!tile) return null;
        const rawId = tile.id;
        if (rawId != null && String(rawId) !== '') return String(rawId);
        return `fb:${tile.bu}|${tile.startedAt || ''}|${tile.mode || ''}|${tile.fromDate || ''}|${tile.toDate || ''}`;
    }, [tile]);
    useEffect(() => {
        if (!modalOpenKey) return;
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
    }, [modalOpenKey]);

    if (!tile) return null;

    const baseEyebrow = tileEyebrow(tile, indexFromOne);
    const isUrine = kind === 'urine_containers';
    const isEdta = kind === 'edta_vials';
    const isCitrate = kind === 'citrate_vials';
    const isSHeparin = kind === 's_heparin';
    const isLHeparin = kind === 'l_heparin';
    const kindBadge = isUrine
        ? 'URINE CONTAINERS'
        : isEdta
          ? 'EDTA VIALS'
          : isCitrate
            ? 'CITRATE VIALS'
            : isSHeparin
              ? 'S.HEPARIN'
              : isLHeparin
                ? 'L.HEPARIN'
                : kind === 'envelopes'
                  ? 'ENVELOPES'
                  : 'LETTER HEADS';
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
    } else if (isEdta) {
        const ev = tile.edtaVials || {};
        totalLabel = 'Vials needed (unique SIDs)';
        totalNum = (ev.sidsTotal || 0).toLocaleString('en-US');
        const btc = ev.byTestCode && typeof ev.byTestCode === 'object' ? ev.byTestCode : {};
        const codes = Object.keys(btc).sort();
        totalSub = codes.length
            ? codes
                  .map((c) => {
                      const row = btc[c] || { sids: 0 };
                      return `${c}: ${(row.sids || 0).toLocaleString('en-US')}`;
                  })
                  .join(' \u00b7 ')
            : null;
    } else if (isCitrate) {
        const cv = tile.citrateVials || {};
        totalLabel = 'Vials needed (unique SIDs)';
        totalNum = (cv.sidsTotal || 0).toLocaleString('en-US');
        const btc = cv.byTestCode && typeof cv.byTestCode === 'object' ? cv.byTestCode : {};
        const codes = Object.keys(btc).sort();
        totalSub = codes.length
            ? codes
                  .map((c) => {
                      const row = btc[c] || { sids: 0 };
                      return `${c}: ${(row.sids || 0).toLocaleString('en-US')}`;
                  })
                  .join(' \u00b7 ')
            : null;
    } else if (isSHeparin) {
        const sh = tile.sHeparin || {};
        totalLabel = 'Tubes needed (unique SIDs)';
        totalNum = (sh.sidsTotal || 0).toLocaleString('en-US');
        const btc = sh.byTestCode && typeof sh.byTestCode === 'object' ? sh.byTestCode : {};
        const codes = Object.keys(btc).sort();
        totalSub = codes.length
            ? codes
                  .map((c) => {
                      const row = btc[c] || { sids: 0 };
                      return `${c}: ${(row.sids || 0).toLocaleString('en-US')}`;
                  })
                  .join(' \u00b7 ')
            : null;
    } else if (isLHeparin) {
        const lh = tile.lHeparin || {};
        totalLabel = 'Tubes needed (unique SIDs)';
        totalNum = (lh.sidsTotal || 0).toLocaleString('en-US');
        const btc = lh.byTestCode && typeof lh.byTestCode === 'object' ? lh.byTestCode : {};
        const codes = Object.keys(btc).sort();
        totalSub = codes.length
            ? codes
                  .map((c) => {
                      const row = btc[c] || { sids: 0 };
                      return `${c}: ${(row.sids || 0).toLocaleString('en-US')}`;
                  })
                  .join(' \u00b7 ')
            : null;
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

    const dialog = (
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
                ) : isEdta ? (
                    <div className="packages-table-host-modal table-wrap">
                        <EdtaBreakdownTable edtaVials={tile.edtaVials} />
                    </div>
                ) : isCitrate ? (
                    <div className="packages-table-host-modal table-wrap">
                        <CitrateBreakdownTable citrateVials={tile.citrateVials} />
                    </div>
                ) : isSHeparin ? (
                    <div className="packages-table-host-modal table-wrap">
                        <SHeparinBreakdownTable sHeparin={tile.sHeparin} />
                    </div>
                ) : isLHeparin ? (
                    <div className="packages-table-host-modal table-wrap">
                        <LHeparinBreakdownTable lHeparin={tile.lHeparin} />
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
    return createPortal(dialog, document.body);
}

/**
 * Per-assay breakdown for EDTA vial runs (dynamic rows from byTestCode).
 */
function EdtaBreakdownTable({ edtaVials }) {
    const ev = edtaVials || {};
    const btc = ev.byTestCode && typeof ev.byTestCode === 'object' ? ev.byTestCode : {};
    const codes = Object.keys(btc).sort();
    const totalSids = ev.sidsTotal || 0;
    const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
    return (
        <table className="edta-breakdown urine-breakdown">
            <thead>
                <tr>
                    <th>Test code</th>
                    <th className="num">SIDs (patients)</th>
                    <th className="num">Rows (raw)</th>
                </tr>
            </thead>
            <tbody>
                {codes.map((code) => {
                    const row = btc[code] || { sids: 0, rows: 0 };
                    return (
                        <tr key={code}>
                            <td>{code}</td>
                            <td className="num">{(row.sids || 0).toLocaleString('en-US')}</td>
                            <td className="num">{(row.rows || 0).toLocaleString('en-US')}</td>
                        </tr>
                    );
                })}
            </tbody>
            <tfoot>
                <tr>
                    <td>Union (OR) — vials needed</td>
                    <td className="num">{totalSids.toLocaleString('en-US')}</td>
                    <td className="num">{totalRows.toLocaleString('en-US')}</td>
                </tr>
            </tfoot>
        </table>
    );
}

/**
 * Per-assay breakdown for S.Heparin runs. Identical row contract to EDTA/Citrate
 * (dynamic rows from byTestCode + union footer = unique tubes needed).
 */
function SHeparinBreakdownTable({ sHeparin }) {
    return <DedupBreakdownTable blob={sHeparin} className="s-heparin-breakdown" footerLabel="Union (OR) — tubes needed" />;
}

/**
 * Per-assay breakdown for L.Heparin runs. Single test code today, but rendered
 * through the same dedup-pipeline component so future expansion is a one-line
 * change in S_HEPARIN_TEST_CODES / L_HEPARIN_TEST_CODES.
 */
function LHeparinBreakdownTable({ lHeparin }) {
    return <DedupBreakdownTable blob={lHeparin} className="l-heparin-breakdown" footerLabel="Union (OR) — tubes needed" />;
}

/**
 * Shared per-assay table for any specialty mode whose tile blob is the
 * { sidsTotal, byTestCode: { code: { sids, rows } } } shape produced by
 * cli/lib/sql-source.js mergePayloads.
 */
function DedupBreakdownTable({ blob, className, footerLabel }) {
    const b = blob || {};
    const btc = b.byTestCode && typeof b.byTestCode === 'object' ? b.byTestCode : {};
    const codes = Object.keys(btc).sort();
    const totalSids = b.sidsTotal || 0;
    const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
    return (
        <table className={`${className} urine-breakdown`}>
            <thead>
                <tr>
                    <th>Test code</th>
                    <th className="num">SIDs (patients)</th>
                    <th className="num">Rows (raw)</th>
                </tr>
            </thead>
            <tbody>
                {codes.map((code) => {
                    const row = btc[code] || { sids: 0, rows: 0 };
                    return (
                        <tr key={code}>
                            <td>{code}</td>
                            <td className="num">{(row.sids || 0).toLocaleString('en-US')}</td>
                            <td className="num">{(row.rows || 0).toLocaleString('en-US')}</td>
                        </tr>
                    );
                })}
            </tbody>
            <tfoot>
                <tr>
                    <td>{footerLabel}</td>
                    <td className="num">{totalSids.toLocaleString('en-US')}</td>
                    <td className="num">{totalRows.toLocaleString('en-US')}</td>
                </tr>
            </tfoot>
        </table>
    );
}

/**
 * Per-assay breakdown for Citrate runs (dynamic rows from byTestCode).
 */
function CitrateBreakdownTable({ citrateVials }) {
    const cv = citrateVials || {};
    const btc = cv.byTestCode && typeof cv.byTestCode === 'object' ? cv.byTestCode : {};
    const codes = Object.keys(btc).sort();
    const totalSids = cv.sidsTotal || 0;
    const totalRows = codes.reduce((s, c) => s + (Number(btc[c] && btc[c].rows) || 0), 0);
    return (
        <table className="citrate-breakdown urine-breakdown">
            <thead>
                <tr>
                    <th>Test code</th>
                    <th className="num">SIDs (patients)</th>
                    <th className="num">Rows (raw)</th>
                </tr>
            </thead>
            <tbody>
                {codes.map((code) => {
                    const row = btc[code] || { sids: 0, rows: 0 };
                    return (
                        <tr key={code}>
                            <td>{code}</td>
                            <td className="num">{(row.sids || 0).toLocaleString('en-US')}</td>
                            <td className="num">{(row.rows || 0).toLocaleString('en-US')}</td>
                        </tr>
                    );
                })}
            </tbody>
            <tfoot>
                <tr>
                    <td>Union (OR) — vials needed</td>
                    <td className="num">{totalSids.toLocaleString('en-US')}</td>
                    <td className="num">{totalRows.toLocaleString('en-US')}</td>
                </tr>
            </tfoot>
        </table>
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
