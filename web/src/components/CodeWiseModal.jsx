import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiFetch } from '../apiClient.js';
import {
    aggregateEnvelopes,
    aggregatePages,
    makeOtherTestsPinned,
    rowsFromLabelOccurrences
} from '../lib/envelopes.js';
import { fmtDateRange } from '../lib/format.js';

// Columns are ordered to match the tile row above the button, so a column can
// be read straight against the tile it breaks down.
const COLUMNS = [
    { key: 'sids', label: 'SIDs', title: 'Unique sample IDs' },
    { key: 'pages', label: 'Pages', title: 'Letter head pages' },
    { key: 'envBig', label: 'Env BIG' },
    { key: 'envSmall', label: 'Env SMALL' },
    { key: 'urineContainers', label: 'Urine' },
    { key: 'edtaVials', label: 'EDTA' },
    { key: 'flourideVials', label: 'Flouride' },
    { key: 'citrateVials', label: 'Citrate' },
    { key: 'sHeparin', label: 'S.Hep' },
    { key: 'lHeparin', label: 'L.Hep' },
    { key: 'lbc', label: 'LBC' },
    { key: 'barcode', label: 'Barcode' },
    { key: 'serum', label: 'Serum' }
];

const UNASSIGNED_LABEL = 'No client code';

function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Excel opens a UTF-8 CSV correctly only when it starts with a BOM — without
 * it, client names with non-ASCII characters arrive mangled.
 */
function downloadCsv(filename, lines) {
    const blob = new Blob([`\uFEFF${lines.join('\r\n')}\r\n`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

function slugForFile(value) {
    return String(value || 'scope')
        .trim()
        .replace(/[^A-Za-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .toLowerCase() || 'scope';
}

/**
 * Code-wise breakdown of a tracer scope: one row per client (MCC) code with
 * the same counts the tiles show for the scope as a whole.
 *
 * The numbers come from the run artefact (`tile.codeWise`), not a fresh query —
 * the LIS scan behind a scope takes minutes, so re-deriving it on open is not
 * an option. Client names are the one thing the artefact lacks; they're fetched
 * from the Postgres client mirror when the modal opens.
 *
 * @param {{
 *   tile: object | null,
 *   bu: string,
 *   fromDate: string,
 *   toDate: string,
 *   clientPagesByNorm: Record<string, number>,
 *   onClose: () => void,
 * }} props
 */
export function CodeWiseModal({ tile, bu, fromDate, toDate, clientPagesByNorm, onClose }) {
    const dialogRef = useRef(null);
    const onCloseRef = useRef(onClose);
    const [filter, setFilter] = useState('');
    const [sort, setSort] = useState({ key: 'sids', dir: 'desc' });
    const [clientsByCode, setClientsByCode] = useState(/** @type {Record<string, object>} */ ({}));

    useEffect(() => {
        onCloseRef.current = onClose;
    }, [onClose]);

    const codeWise = tile && tile.codeWise && Array.isArray(tile.codeWise.codes) ? tile.codeWise : null;

    const rows = useMemo(() => {
        if (!codeWise) return [];
        return codeWise.codes.map((entry) => {
            const occRows = rowsFromLabelOccurrences(entry.labelOccurrences);
            const pinned = makeOtherTestsPinned(entry.otherTestsRowCount);
            const pages = aggregatePages(occRows, pinned, clientPagesByNorm);
            const env = aggregateEnvelopes(occRows, pinned, clientPagesByNorm);
            const modes = entry.modes && typeof entry.modes === 'object' ? entry.modes : {};
            return {
                code: entry.code || null,
                sids: Number(entry.sids) || 0,
                pages: pages.knownSum,
                pagesEstimated: pages.unknownLabels > 0,
                envBig: env.big,
                envSmall: env.small,
                urineContainers: Number(modes.urineContainers) || 0,
                edtaVials: Number(modes.edtaVials) || 0,
                flourideVials: Number(modes.flourideVials) || 0,
                citrateVials: Number(modes.citrateVials) || 0,
                sHeparin: Number(modes.sHeparin) || 0,
                lHeparin: Number(modes.lHeparin) || 0,
                lbc: Number(modes.lbc) || 0,
                barcode: Number(modes.barcode) || 0,
                serum: Number(modes.serum) || 0
            };
        });
    }, [codeWise, clientPagesByNorm]);

    // Names live in the client mirror, so one lookup covers every code in the
    // table. A failed lookup is not worth surfacing — the codes still render.
    useEffect(() => {
        const codes = rows.map((r) => r.code).filter(Boolean);
        if (codes.length === 0) return undefined;
        let cancelled = false;
        apiFetch(`/api/tracer/client-codes?codes=${encodeURIComponent(codes.join(','))}`)
            .then((r) => r.json())
            .then((j) => {
                if (!cancelled && j && j.clientsByCode) setClientsByCode(j.clientsByCode);
            })
            .catch(() => {});
        return () => {
            cancelled = true;
        };
    }, [rows]);

    const decorated = useMemo(
        () =>
            rows.map((r) => {
                const meta = r.code ? clientsByCode[r.code] : null;
                return {
                    ...r,
                    name: meta && meta.name ? meta.name : null,
                    city: meta && meta.city ? meta.city : null,
                    state: meta && meta.state ? meta.state : null
                };
            }),
        [rows, clientsByCode]
    );

    const visible = useMemo(() => {
        const q = filter.trim().toLowerCase();
        const matched = q
            ? decorated.filter(
                  (r) =>
                      (r.code || '').toLowerCase().includes(q) ||
                      (r.name || '').toLowerCase().includes(q) ||
                      (r.city || '').toLowerCase().includes(q)
              )
            : decorated.slice();
        const factor = sort.dir === 'asc' ? 1 : -1;
        matched.sort((a, b) => {
            if (sort.key === 'code') {
                return factor * String(a.code || '').localeCompare(String(b.code || ''));
            }
            if (sort.key === 'name') {
                return factor * String(a.name || '').localeCompare(String(b.name || ''));
            }
            return factor * ((Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0)) ||
                String(a.code || '').localeCompare(String(b.code || ''));
        });
        return matched;
    }, [decorated, filter, sort]);

    const totals = useMemo(() => {
        const out = {};
        for (const col of COLUMNS) out[col.key] = 0;
        for (const r of visible) {
            for (const col of COLUMNS) out[col.key] += Number(r[col.key]) || 0;
        }
        return out;
    }, [visible]);

    const openKey = tile ? String(tile.id || `${bu}|${tile.startedAt || ''}`) : null;
    useEffect(() => {
        if (!openKey) return undefined;
        const dlg = dialogRef.current;
        if (!dlg) return undefined;
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
    }, [openKey]);

    if (!tile) return null;

    const range = fmtDateRange(fromDate, toDate);

    const exportCsv = () => {
        const header = ['Client code', 'Client', 'City', 'State', ...COLUMNS.map((c) => c.label)];
        const body = visible.map((r) =>
            [
                r.code || UNASSIGNED_LABEL,
                r.name || '',
                r.city || '',
                r.state || '',
                ...COLUMNS.map((c) => r[c.key])
            ].map(csvCell)
        );
        const footer = ['TOTAL', '', '', '', ...COLUMNS.map((c) => totals[c.key])].map(csvCell);
        const lines = [
            [`Code-wise breakdown — ${bu}`, range].map(csvCell).join(','),
            '',
            header.map(csvCell).join(','),
            ...body.map((cells) => cells.join(',')),
            footer.join(',')
        ];
        downloadCsv(`code-wise-${slugForFile(bu)}-${fromDate || ''}.csv`, lines);
    };

    const toggleSort = (key) =>
        setSort((prev) => (prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

    const sortMark = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

    const dialog = (
        <dialog ref={dialogRef} className="run-modal code-wise-modal">
            <div className="run-modal-inner nexus-card">
                <header className="run-modal-header row-between">
                    <div>
                        <p className="eyebrow">CODE-WISE COUNT</p>
                        <h2 className="run-modal-title">{String(bu || '—')}</h2>
                        <p className="muted small">{range}</p>
                    </div>
                    <div className="code-wise-actions">
                        <button
                            type="button"
                            className="chip chip-tool"
                            onClick={exportCsv}
                            disabled={visible.length === 0}
                        >
                            Export to Excel
                        </button>
                        <button type="button" className="chip chip-tool" aria-label="Close" onClick={onClose}>
                            Close
                        </button>
                    </div>
                </header>

                {!codeWise ? (
                    <p className="muted small code-wise-empty">
                        This run has no code-wise data. It was recorded before the breakdown existed — re-run the
                        tracer for this scope and the table will be there.
                    </p>
                ) : (
                    <>
                        <div className="packages-toolbar modal-packages-toolbar">
                            <input
                                type="search"
                                placeholder="Filter code, client, city…"
                                autoComplete="off"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                            />
                            <span className="muted small">
                                {visible.length === decorated.length
                                    ? `${decorated.length} code${decorated.length === 1 ? '' : 's'}`
                                    : `${visible.length} of ${decorated.length} codes`}
                            </span>
                        </div>
                        <div className="packages-table-host-modal table-wrap">
                            <table className="code-wise-table urine-breakdown">
                                <thead>
                                    <tr>
                                        <th>
                                            <button type="button" className="th-sort" onClick={() => toggleSort('code')}>
                                                {`Code${sortMark('code')}`}
                                            </button>
                                        </th>
                                        <th>
                                            <button type="button" className="th-sort" onClick={() => toggleSort('name')}>
                                                {`Client${sortMark('name')}`}
                                            </button>
                                        </th>
                                        {COLUMNS.map((col) => (
                                            <th key={col.key} className="num" title={col.title || undefined}>
                                                <button
                                                    type="button"
                                                    className="th-sort"
                                                    onClick={() => toggleSort(col.key)}
                                                >
                                                    {`${col.label}${sortMark(col.key)}`}
                                                </button>
                                            </th>
                                        ))}
                                    </tr>
                                </thead>
                                <tbody>
                                    {visible.map((r) => (
                                        <tr key={r.code || '(unassigned)'}>
                                            <td>{r.code ? <code>{r.code}</code> : <em>{UNASSIGNED_LABEL}</em>}</td>
                                            <td>
                                                {r.name || <span className="muted">Not in client mirror</span>}
                                                {r.city ? <span className="muted small"> · {r.city}</span> : null}
                                            </td>
                                            {COLUMNS.map((col) => (
                                                <td key={col.key} className="num">
                                                    {(Number(r[col.key]) || 0).toLocaleString('en-US')}
                                                    {col.key === 'pages' && r.pagesEstimated ? '*' : ''}
                                                </td>
                                            ))}
                                        </tr>
                                    ))}
                                </tbody>
                                <tfoot>
                                    <tr>
                                        <td>TOTAL</td>
                                        <td>{`${visible.length} code${visible.length === 1 ? '' : 's'}`}</td>
                                        {COLUMNS.map((col) => (
                                            <td key={col.key} className="num">
                                                {(totals[col.key] || 0).toLocaleString('en-US')}
                                            </td>
                                        ))}
                                    </tr>
                                </tfoot>
                            </table>
                        </div>
                        <footer className="run-modal-footer row-between">
                            <span className="eyebrow-lite">Counts are unique SIDs per client code</span>
                            <span className="muted small">
                                * page count is a minimum — some labels have no pages-per-report mapping
                            </span>
                        </footer>
                    </>
                )}
            </div>
        </dialog>
    );

    return createPortal(dialog, document.body);
}
