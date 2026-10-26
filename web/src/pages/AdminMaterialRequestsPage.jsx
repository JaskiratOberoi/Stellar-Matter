import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Topbar } from '../components/Topbar.jsx';
import { InfinitySourceTag } from '../components/InfinityMark.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useMaterialRequests } from '../hooks/useMaterialRequests.js';

const REQUEST_FILTERS = [
    { id: 'submitted', label: 'Submitted' },
    { id: 'approved', label: 'Approved' },
    { id: 'batched', label: 'Batched' },
    { id: 'cancelled', label: 'Cancelled' },
    { id: 'all', label: 'All' }
];

const STATUS_LABEL = {
    submitted: 'Submitted',
    approved: 'Approved',
    batched: 'Batched',
    cancelled: 'Cancelled',
    draft: 'Draft',
    sent: 'Sent'
};

function fmtWhen(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtDay(v) {
    if (!v) return '—';
    const d = new Date(`${String(v).slice(0, 10)}T12:00:00`);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Needed-by against today, for requests still open. */
function dueTone(r) {
    if (!r.needed_by || (r.status !== 'submitted' && r.status !== 'approved')) return null;
    const due = new Date(`${String(r.needed_by).slice(0, 10)}T23:59:59`).getTime();
    const days = Math.floor((due - Date.now()) / 86400000);
    if (days < 0) return { tone: 'danger', text: `${-days} day${days === -1 ? '' : 's'} late` };
    if (days <= 2) return { tone: 'warn', text: days === 0 ? 'due today' : `due in ${days} day${days === 1 ? '' : 's'}` };
    return null;
}

function contactHref(contact) {
    const c = String(contact || '').trim();
    if (/^\S+@\S+\.\S+$/.test(c)) return `mailto:${c}`;
    if (/^[+\d][\d\s-]{6,}$/.test(c)) return `tel:${c.replace(/[\s-]/g, '')}`;
    return null;
}

function StatusChip({ status }) {
    return <span className={`mreq-status mreq-status--${status}`}>{STATUS_LABEL[status] || status}</span>;
}

/** Cancel with an optional reason, typed in place. */
function CancelAsk({ what, busy, onConfirm, onKeep }) {
    const [reason, setReason] = useState('');
    const ref = useRef(null);
    useEffect(() => {
        if (ref.current) ref.current.focus();
    }, []);
    return (
        <div className="mreq-cancel" role="group" aria-label={`Cancel ${what}`}>
            <input
                ref={ref}
                type="text"
                placeholder="Reason (optional)"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onConfirm(reason.trim() || null);
                    if (e.key === 'Escape') onKeep();
                }}
            />
            <button type="button" className="chip chip-tool chip-danger" disabled={busy} onClick={() => onConfirm(reason.trim() || null)}>
                Cancel {what}
            </button>
            <button type="button" className="chip chip-tool" onClick={onKeep}>
                Keep
            </button>
        </div>
    );
}

export function AdminMaterialRequestsPage() {
    const { user } = useAuth();
    const isSuper = user?.role === 'super_admin';
    const mr = useMaterialRequests();
    const { requests, batches, loading, error, reload } = mr;

    const [tab, setTab] = useState('requests');
    const [filter, setFilter] = useState('submitted');
    const [selected, setSelected] = useState(() => new Set());
    const [detail, setDetail] = useState(null);
    const [detailKind, setDetailKind] = useState(null);
    const [busy, setBusy] = useState(false);
    const [toast, setToast] = useState(null);
    const [batchNote, setBatchNote] = useState('');
    const [cancelling, setCancelling] = useState(null); // { kind, id }
    const panelRef = useRef(null);

    const counts = useMemo(() => {
        const c = { all: requests.length };
        for (const r of requests) c[r.status] = (c[r.status] || 0) + 1;
        return c;
    }, [requests]);
    const filtered = useMemo(
        () => (filter === 'all' ? requests : requests.filter((r) => r.status === filter)),
        [requests, filter]
    );
    const picked = requests.filter((r) => selected.has(r.id));
    const pickedSubmitted = picked.filter((r) => r.status === 'submitted');
    const pickedApproved = picked.filter((r) => r.status === 'approved');

    useEffect(() => {
        setSelected(new Set());
    }, [filter, tab]);

    function say(text, tone = 'ok') {
        setToast({ text, tone, n: Date.now() });
        window.clearTimeout(say._t);
        say._t = window.setTimeout(() => setToast(null), 5000);
    }

    async function open(kind, id) {
        setBusy(true);
        try {
            const obj = kind === 'request' ? await mr.getRequest(id) : await mr.getBatch(id);
            setDetail(obj);
            setDetailKind(kind);
            setCancelling(null);
            // Phones: the panel sits below the list; bring it into view.
            requestAnimationFrame(() => {
                if (panelRef.current && window.innerWidth <= 1000) {
                    panelRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
            });
        } catch (e) {
            say(String(e.message || e), 'error');
        } finally {
            setBusy(false);
        }
    }

    async function run(fn, okText) {
        setBusy(true);
        try {
            await fn();
            say(okText);
            setCancelling(null);
            if (detail) {
                try {
                    setDetail(detailKind === 'request' ? await mr.getRequest(detail.id) : await mr.getBatch(detail.id));
                } catch {
                    setDetail(null);
                    setDetailKind(null);
                }
            }
        } catch (e) {
            say(String(e.message || e), 'error');
        } finally {
            setBusy(false);
        }
    }

    function toggle(id) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    async function approveSelected() {
        const ids = pickedSubmitted.map((r) => r.id);
        await run(async () => {
            for (const id of ids) await mr.approve(id);
            setSelected(new Set());
        }, `Approved ${ids.length} request${ids.length === 1 ? '' : 's'}.`);
    }

    async function combineSelected() {
        const ids = pickedApproved.map((r) => r.id);
        await run(async () => {
            const batch = await mr.combine(ids, batchNote.trim() || null);
            setSelected(new Set());
            setBatchNote('');
            setTab('batches');
            setDetail(batch);
            setDetailKind('batch');
        }, `Combined ${ids.length} request${ids.length === 1 ? '' : 's'} into a batch.`);
    }

    const waiting = counts.submitted || 0;

    return (
        <>
            <Topbar onOrgSwitched={() => reload()} />
            <main className="admin-shell mreq-admin">
                <header className="admin-header row-between">
                    <div>
                        <p className="eyebrow">Admin</p>
                        <h1 className="wordmark">Material requests</h1>
                        <p className="muted small">
                            Requests from sites and labs, sent through the public form. Approve or cancel them, then
                            combine approved ones into a batch for supply.
                        </p>
                    </div>
                    <div className="admin-actions">
                        <Link to="/request" className="chip chip-tool" target="_blank" rel="noreferrer">
                            Open public form ↗
                        </Link>
                    </div>
                </header>

                <div className="mreq-viewtabs" role="tablist" aria-label="Material requests views">
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'requests' ? 'true' : 'false'}
                        className={tab === 'requests' ? 'is-active' : undefined}
                        onClick={() => setTab('requests')}
                    >
                        Requests
                        {waiting > 0 && <span className="mreq-count">{waiting} waiting</span>}
                    </button>
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'batches' ? 'true' : 'false'}
                        className={tab === 'batches' ? 'is-active' : undefined}
                        onClick={() => setTab('batches')}
                    >
                        Batches
                        {batches.length > 0 && <span className="mreq-count is-quiet">{batches.length}</span>}
                    </button>
                </div>

                {error && <div className="results-error nexus-card">{error}</div>}

                <div className={`mreq-layout${detail ? ' has-panel' : ''}`}>
                    <section className="mreq-main">
                        {tab === 'requests' && (
                            <>
                                <div className="mreq-filters" role="radiogroup" aria-label="Status">
                                    {REQUEST_FILTERS.map((f) => (
                                        <button
                                            key={f.id}
                                            type="button"
                                            role="radio"
                                            aria-checked={filter === f.id ? 'true' : 'false'}
                                            className="chip chip-tool"
                                            onClick={() => setFilter(f.id)}
                                        >
                                            {f.label} {counts[f.id] ? `· ${counts[f.id]}` : ''}
                                        </button>
                                    ))}
                                </div>

                                {picked.length > 0 && (
                                    <div className="mreq-bulk" role="region" aria-label="Selected requests">
                                        <span>
                                            <strong>{picked.length}</strong> selected
                                        </span>
                                        {pickedSubmitted.length > 0 && (
                                            <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={approveSelected}>
                                                Approve {pickedSubmitted.length}
                                            </button>
                                        )}
                                        {pickedApproved.length > 0 && (
                                            <>
                                                <input
                                                    type="text"
                                                    className="mreq-bulk-note"
                                                    placeholder="Batch note (optional)"
                                                    value={batchNote}
                                                    onChange={(e) => setBatchNote(e.target.value)}
                                                />
                                                <button type="button" className="btn-primary btn-sm" disabled={busy} onClick={combineSelected}>
                                                    Combine {pickedApproved.length} into a batch
                                                </button>
                                            </>
                                        )}
                                        <button type="button" className="chip chip-tool" onClick={() => setSelected(new Set())}>
                                            Clear
                                        </button>
                                    </div>
                                )}

                                {loading ? (
                                    <p className="muted">Loading…</p>
                                ) : !filtered.length ? (
                                    <p className="muted mreq-empty">
                                        {filter === 'submitted' ? 'Nothing waiting for review.' : 'No requests here.'}
                                    </p>
                                ) : (
                                    <ul className="mreq-list">
                                        {filtered.map((r) => {
                                            const due = dueTone(r);
                                            const selectable = r.status === 'submitted' || r.status === 'approved';
                                            const isOpen = detailKind === 'request' && detail && detail.id === r.id;
                                            return (
                                                <li key={r.id} className={`mreq-row${isOpen ? ' is-open' : ''}`}>
                                                    <span className="mreq-pick">
                                                        {selectable && (
                                                            <input
                                                                type="checkbox"
                                                                aria-label={`Select request from ${r.requester_name}`}
                                                                checked={selected.has(r.id)}
                                                                onChange={() => toggle(r.id)}
                                                            />
                                                        )}
                                                    </span>
                                                    <button type="button" className="mreq-row-main" onClick={() => open('request', r.id)}>
                                                        <span className="mreq-who">
                                                            <strong>
                                                                {r.requester_name}
                                                                {r.source === 'infinity' && <InfinitySourceTag meta={r.source_meta} compact />}
                                                            </strong>
                                                            <span className="muted small">
                                                                {r.location_text || 'No location given'}
                                                                {r.source === 'infinity' && r.source_meta && (r.source_meta.region || r.source_meta.state)
                                                                    ? ` · ${r.source_meta.region || r.source_meta.state}` : ''}
                                                            </span>
                                                        </span>
                                                        <span className="mreq-meta-line">
                                                            {r.line_count} item{r.line_count === 1 ? '' : 's'} · sent {fmtWhen(r.created_at)}
                                                            {r.needed_by ? ` · needed ${fmtDay(r.needed_by)}` : ''}
                                                            {due && <span className={`mreq-due is-${due.tone}`}> · {due.text}</span>}
                                                        </span>
                                                    </button>
                                                    <span className="mreq-row-status">
                                                        <StatusChip status={r.status} />
                                                    </span>
                                                    <span className="mreq-row-actions">
                                                        {r.status === 'submitted' && (
                                                            <button
                                                                type="button"
                                                                className="chip chip-tool"
                                                                disabled={busy}
                                                                onClick={() => run(() => mr.approve(r.id), `Approved ${r.requester_name}'s request.`)}
                                                            >
                                                                Approve
                                                            </button>
                                                        )}
                                                    </span>
                                                </li>
                                            );
                                        })}
                                    </ul>
                                )}
                            </>
                        )}

                        {tab === 'batches' &&
                            (loading ? (
                                <p className="muted">Loading…</p>
                            ) : !batches.length ? (
                                <p className="muted mreq-empty">
                                    No batches yet. Approve requests, select them and combine them into a batch.
                                </p>
                            ) : (
                                <ul className="mreq-list">
                                    {batches.map((b) => {
                                        const isOpen = detailKind === 'batch' && detail && detail.id === b.id;
                                        return (
                                            <li key={b.id} className={`mreq-row is-batch${isOpen ? ' is-open' : ''}`}>
                                                <button type="button" className="mreq-row-main" onClick={() => open('batch', b.id)}>
                                                    <span className="mreq-who">
                                                        <strong>
                                                            {b.request_count} request{b.request_count === 1 ? '' : 's'}
                                                        </strong>
                                                        <span className="muted small">{b.note || 'No note'}</span>
                                                    </span>
                                                    <span className="mreq-meta-line">
                                                        made {fmtWhen(b.created_at)}
                                                        {b.created_by ? ` · by ${b.created_by}` : ''}
                                                    </span>
                                                </button>
                                                <span className="mreq-row-status">
                                                    <StatusChip status={b.status} />
                                                </span>
                                            </li>
                                        );
                                    })}
                                </ul>
                            ))}
                    </section>

                    {detail && (
                        <aside className="mreq-panel nexus-card" ref={panelRef} aria-label="Details">
                            {detailKind === 'request' ? (
                                <RequestPanel
                                    request={detail}
                                    busy={busy}
                                    cancelling={cancelling && cancelling.kind === 'request' && cancelling.id === detail.id}
                                    onAskCancel={() => setCancelling({ kind: 'request', id: detail.id })}
                                    onKeep={() => setCancelling(null)}
                                    onApprove={() => run(() => mr.approve(detail.id), 'Request approved.')}
                                    onCancel={(reason) => run(() => mr.cancelRequest(detail.id, reason), 'Request cancelled.')}
                                    onClose={() => setDetail(null)}
                                />
                            ) : (
                                <BatchPanel
                                    batch={detail}
                                    busy={busy}
                                    isSuper={isSuper}
                                    cancelling={cancelling && cancelling.kind === 'batch' && cancelling.id === detail.id}
                                    onAskCancel={() => setCancelling({ kind: 'batch', id: detail.id })}
                                    onKeep={() => setCancelling(null)}
                                    onSubmit={() => run(() => mr.submitBatch(detail.id), 'Batch sent to supply.')}
                                    onSend={() => run(() => mr.sendBatch(detail.id), 'Batch marked as sent.')}
                                    onCancel={(reason) =>
                                        run(() => mr.cancelBatch(detail.id, reason), 'Batch cancelled; its requests are back to Approved.')
                                    }
                                    onClose={() => setDetail(null)}
                                />
                            )}
                        </aside>
                    )}
                </div>

                {toast && (
                    <div className={`inv-toast${toast.tone === 'error' ? ' is-error' : ''}`} role="status" key={toast.n}>
                        <span>{toast.text}</span>
                        <button type="button" className="inv-toast-x" aria-label="Dismiss" onClick={() => setToast(null)}>
                            ×
                        </button>
                    </div>
                )}
            </main>
        </>
    );
}

function RequestPanel({ request, busy, cancelling, onAskCancel, onKeep, onApprove, onCancel, onClose }) {
    const href = contactHref(request.requester_contact);
    const open = request.status === 'submitted' || request.status === 'approved';
    return (
        <>
            <div className="mreq-panel-head">
                <div>
                    <p className="eyebrow-lite">Request</p>
                    <h2 className="mreq-panel-title">{request.requester_name}</h2>
                    <StatusChip status={request.status} />
                </div>
                <button type="button" className="chip chip-tool" onClick={onClose}>
                    Close
                </button>
            </div>
            <dl className="mreq-facts">
                {request.source === 'infinity' && (
                    <div className="mreq-fact-wide">
                        <dt>Raised from</dt>
                        <dd><InfinitySourceTag meta={request.source_meta} /></dd>
                    </div>
                )}
                <div>
                    <dt>Contact</dt>
                    <dd>{href ? <a href={href}>{request.requester_contact}</a> : request.requester_contact || '—'}</dd>
                </div>
                <div>
                    <dt>Location</dt>
                    <dd>{request.location_text || '—'}</dd>
                </div>
                <div>
                    <dt>Needed by</dt>
                    <dd>{fmtDay(request.needed_by)}</dd>
                </div>
                <div>
                    <dt>Sent</dt>
                    <dd>{fmtWhen(request.created_at)}</dd>
                </div>
                {request.cancel_reason && (
                    <div>
                        <dt>Cancel reason</dt>
                        <dd>{request.cancel_reason}</dd>
                    </div>
                )}
            </dl>
            {request.notes && <p className="mreq-notes">{request.notes}</p>}
            <table className="mreq-items">
                <thead>
                    <tr>
                        <th>Item</th>
                        <th className="num">Quantity</th>
                    </tr>
                </thead>
                <tbody>
                    {(request.lines || []).map((line) => (
                        <tr key={line.id}>
                            <td>
                                {line.material_name}
                                {line.is_custom ? <span className="mreq-custom">not in catalog</span> : null}
                            </td>
                            <td className="num">
                                {Number(line.quantity).toLocaleString()} <span className="muted small">{line.unit}</span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {open &&
                (cancelling ? (
                    <CancelAsk what="request" busy={busy} onConfirm={onCancel} onKeep={onKeep} />
                ) : (
                    <div className="mreq-panel-actions">
                        {request.status === 'submitted' && (
                            <button type="button" className="btn-primary" disabled={busy} onClick={onApprove}>
                                Approve
                            </button>
                        )}
                        <button type="button" className="chip chip-tool" disabled={busy} onClick={onAskCancel}>
                            Cancel request
                        </button>
                    </div>
                ))}
        </>
    );
}

function BatchPanel({ batch, busy, isSuper, cancelling, onAskCancel, onKeep, onSubmit, onSend, onCancel, onClose }) {
    // Everything in the batch, summed per item across its requests.
    const totals = useMemo(() => {
        const m = new Map();
        for (const r of batch.requests || []) {
            for (const l of r.lines || []) {
                const key = `${l.material_name}|${l.unit}`;
                const cur = m.get(key) || { name: l.material_name, unit: l.unit, qty: 0, custom: l.is_custom };
                cur.qty += Number(l.quantity) || 0;
                m.set(key, cur);
            }
        }
        return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    }, [batch]);
    const open = batch.status === 'draft' || batch.status === 'submitted';
    return (
        <>
            <div className="mreq-panel-head">
                <div>
                    <p className="eyebrow-lite">Batch</p>
                    <h2 className="mreq-panel-title">
                        {(batch.requests || []).length} request{(batch.requests || []).length === 1 ? '' : 's'}
                    </h2>
                    <StatusChip status={batch.status} />
                </div>
                <button type="button" className="chip chip-tool" onClick={onClose}>
                    Close
                </button>
            </div>
            <p className="muted small">
                {batch.note ? `${batch.note} · ` : ''}made {fmtWhen(batch.created_at)}
                {batch.created_by ? ` by ${batch.created_by}` : ''}
            </p>
            {batch.status === 'cancelled' && !(batch.requests || []).length && (
                <p className="mreq-notes">
                    Cancelled{batch.cancel_reason ? `: ${batch.cancel_reason}` : ''}. Its requests went back to Approved.
                </p>
            )}
            <p className="eyebrow-lite mreq-sub">Total to supply</p>
            <table className="mreq-items">
                <tbody>
                    {totals.map((t) => (
                        <tr key={`${t.name}|${t.unit}`}>
                            <td>
                                {t.name}
                                {t.custom ? <span className="mreq-custom">not in catalog</span> : null}
                            </td>
                            <td className="num">
                                {t.qty.toLocaleString()} <span className="muted small">{t.unit}</span>
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
            <p className="eyebrow-lite mreq-sub">Requests in this batch</p>
            <ul className="mreq-batch-reqs">
                {(batch.requests || []).map((r) => (
                    <li key={r.id}>
                        <strong>{r.requester_name}</strong>
                        <span className="muted small">
                            {r.location_text || 'No location'} · {(r.lines || []).length} item{(r.lines || []).length === 1 ? '' : 's'}
                        </span>
                    </li>
                ))}
            </ul>
            {open &&
                (cancelling ? (
                    <CancelAsk what="batch" busy={busy} onConfirm={onCancel} onKeep={onKeep} />
                ) : (
                    <div className="mreq-panel-actions">
                        {batch.status === 'draft' && (
                            <button type="button" className="btn-primary" disabled={busy} onClick={onSubmit}>
                                Send to supply
                            </button>
                        )}
                        {batch.status === 'submitted' && isSuper && (
                            <button type="button" className="btn-primary" disabled={busy} onClick={onSend}>
                                Mark as sent
                            </button>
                        )}
                        <button type="button" className="chip chip-tool" disabled={busy} onClick={onAskCancel}>
                            Cancel batch
                        </button>
                    </div>
                ))}
        </>
    );
}
