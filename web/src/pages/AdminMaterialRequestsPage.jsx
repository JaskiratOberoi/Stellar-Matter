import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Topbar } from '../components/Topbar.jsx';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useMaterialRequests } from '../hooks/useMaterialRequests.js';

function fmtDate(v) {
    if (!v) return '—';
    const d = new Date(v);
    if (Number.isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function StatusChip({ status }) {
    return <span className={`mreq-status mreq-status--${status}`}>{status}</span>;
}

export function AdminMaterialRequestsPage() {
    const { user } = useAuth();
    const isSuper = user?.role === 'super_admin';
    const {
        requests,
        batches,
        loading,
        error,
        reload,
        approve,
        cancelRequest,
        getRequest,
        combine,
        getBatch,
        submitBatch,
        sendBatch,
        cancelBatch
    } = useMaterialRequests();

    const [tab, setTab] = useState('queue'); // queue | batches
    const [filter, setFilter] = useState('submitted');
    const [selected, setSelected] = useState(() => new Set());
    const [detail, setDetail] = useState(null); // request or batch object
    const [detailKind, setDetailKind] = useState(null); // 'request' | 'batch'
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState(null);
    const [batchNote, setBatchNote] = useState('');

    const filtered = useMemo(() => {
        if (!filter || filter === 'all') return requests;
        return requests.filter((r) => r.status === filter);
    }, [requests, filter]);

    const approvedSelected = useMemo(() => {
        return [...selected].filter((id) => {
            const r = requests.find((x) => x.id === id);
            return r && r.status === 'approved';
        });
    }, [selected, requests]);

    function toggleSelect(id) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }

    async function openRequest(id) {
        setBusy(true);
        setNotice(null);
        try {
            const r = await getRequest(id);
            setDetail(r);
            setDetailKind('request');
        } catch (e) {
            setNotice({ kind: 'error', text: String(e.message || e) });
        } finally {
            setBusy(false);
        }
    }

    async function openBatch(id) {
        setBusy(true);
        setNotice(null);
        try {
            const b = await getBatch(id);
            setDetail(b);
            setDetailKind('batch');
        } catch (e) {
            setNotice({ kind: 'error', text: String(e.message || e) });
        } finally {
            setBusy(false);
        }
    }

    async function runAction(fn, okMsg) {
        setBusy(true);
        setNotice(null);
        try {
            await fn();
            setNotice({ kind: 'success', text: okMsg });
            if (detailKind === 'request' && detail) {
                try {
                    setDetail(await getRequest(detail.id));
                } catch {
                    setDetail(null);
                    setDetailKind(null);
                }
            } else if (detailKind === 'batch' && detail) {
                try {
                    setDetail(await getBatch(detail.id));
                } catch {
                    setDetail(null);
                    setDetailKind(null);
                }
            }
        } catch (e) {
            setNotice({ kind: 'error', text: String(e.message || e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <Topbar onOrgSwitched={() => reload()} />
            <main className="admin-shell mreq-admin">
                <header className="admin-header row-between">
                    <div>
                        <p className="eyebrow">Admin</p>
                        <h1 className="wordmark">Materials requests</h1>
                        <p className="muted small">
                            Review public submissions, cancel or approve them, combine approved requests into a
                            batch, then hand the batch to supply / super admin.
                        </p>
                    </div>
                    <div className="admin-actions">
                        <Link to="/" className="chip chip-tool">
                            ← Inventory
                        </Link>
                        <Link to="/request" className="chip chip-tool" target="_blank" rel="noreferrer">
                            Public form
                        </Link>
                        <button type="button" className="chip chip-tool" disabled={busy} onClick={() => reload()}>
                            Refresh
                        </button>
                    </div>
                </header>

                <div className="mreq-tabs">
                    <button
                        type="button"
                        className={`chip chip-tool${tab === 'queue' ? ' is-active' : ''}`}
                        onClick={() => setTab('queue')}
                    >
                        Request queue
                    </button>
                    <button
                        type="button"
                        className={`chip chip-tool${tab === 'batches' ? ' is-active' : ''}`}
                        onClick={() => setTab('batches')}
                    >
                        Batches
                    </button>
                </div>

                {notice && (
                    <p className={`admin-notice ${notice.kind === 'error' ? 'is-error' : 'is-success'}`}>
                        {notice.text}
                    </p>
                )}
                {error && <div className="results-error nexus-card">{error}</div>}

                {tab === 'queue' && (
                    <>
                        <div className="mreq-toolbar row-between">
                            <label className="mreq-filter">
                                <span className="muted small">Status</span>
                                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                                    <option value="submitted">submitted</option>
                                    <option value="approved">approved</option>
                                    <option value="batched">batched</option>
                                    <option value="cancelled">cancelled</option>
                                    <option value="all">all</option>
                                </select>
                            </label>
                            <div className="mreq-combine">
                                <input
                                    type="text"
                                    placeholder="Batch note (optional)"
                                    value={batchNote}
                                    onChange={(e) => setBatchNote(e.target.value)}
                                    disabled={!approvedSelected.length}
                                />
                                <button
                                    type="button"
                                    className="btn-primary"
                                    disabled={busy || approvedSelected.length < 1}
                                    onClick={() =>
                                        runAction(
                                            async () => {
                                                const batch = await combine(approvedSelected, batchNote.trim() || null);
                                                setSelected(new Set());
                                                setBatchNote('');
                                                setTab('batches');
                                                setDetail(batch);
                                                setDetailKind('batch');
                                            },
                                            `Combined ${approvedSelected.length} request(s) into a batch`
                                        )
                                    }
                                >
                                    Combine selected ({approvedSelected.length})
                                </button>
                            </div>
                        </div>

                        {loading ? (
                            <p className="muted">Loading…</p>
                        ) : (
                            <div className="inv-table-wrap">
                                <table className="packages">
                                    <thead>
                                        <tr>
                                            <th />
                                            <th>When</th>
                                            <th>Requester</th>
                                            <th>Location</th>
                                            <th>Needed by</th>
                                            <th>Lines</th>
                                            <th>Status</th>
                                            <th>Actions</th>
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {filtered.map((r) => (
                                            <tr key={r.id}>
                                                <td>
                                                    <input
                                                        type="checkbox"
                                                        disabled={r.status !== 'approved'}
                                                        checked={selected.has(r.id)}
                                                        onChange={() => toggleSelect(r.id)}
                                                        title={
                                                            r.status === 'approved'
                                                                ? 'Select for combine'
                                                                : 'Only approved requests can be combined'
                                                        }
                                                    />
                                                </td>
                                                <td className="muted small">{fmtDate(r.created_at)}</td>
                                                <td>
                                                    <div className="label">{r.requester_name}</div>
                                                    <div className="muted small">{r.requester_contact}</div>
                                                </td>
                                                <td>{r.location_text || '—'}</td>
                                                <td>{r.needed_by || '—'}</td>
                                                <td>{r.line_count}</td>
                                                <td>
                                                    <StatusChip status={r.status} />
                                                </td>
                                                <td className="admin-row-actions">
                                                    <button
                                                        type="button"
                                                        className="chip chip-tool"
                                                        disabled={busy}
                                                        onClick={() => openRequest(r.id)}
                                                    >
                                                        Open
                                                    </button>
                                                    {r.status === 'submitted' && (
                                                        <>
                                                            <button
                                                                type="button"
                                                                className="chip chip-tool"
                                                                disabled={busy}
                                                                onClick={() =>
                                                                    runAction(
                                                                        () => approve(r.id),
                                                                        'Request approved'
                                                                    )
                                                                }
                                                            >
                                                                Approve
                                                            </button>
                                                            <button
                                                                type="button"
                                                                className="chip chip-tool"
                                                                disabled={busy}
                                                                onClick={() => {
                                                                    const reason = window.prompt(
                                                                        'Cancel reason (optional):'
                                                                    );
                                                                    if (reason === null) return;
                                                                    return runAction(
                                                                        () => cancelRequest(r.id, reason || null),
                                                                        'Request cancelled'
                                                                    );
                                                                }}
                                                            >
                                                                Cancel
                                                            </button>
                                                        </>
                                                    )}
                                                    {r.status === 'approved' && (
                                                        <button
                                                            type="button"
                                                            className="chip chip-tool"
                                                            disabled={busy}
                                                            onClick={() => {
                                                                const reason = window.prompt(
                                                                    'Cancel reason (optional):'
                                                                );
                                                                if (reason === null) return;
                                                                return runAction(
                                                                    () => cancelRequest(r.id, reason || null),
                                                                    'Request cancelled'
                                                                );
                                                            }}
                                                        >
                                                            Cancel
                                                        </button>
                                                    )}
                                                </td>
                                            </tr>
                                        ))}
                                        {!filtered.length && (
                                            <tr>
                                                <td colSpan={8} className="muted">
                                                    No requests in this view.
                                                </td>
                                            </tr>
                                        )}
                                    </tbody>
                                </table>
                            </div>
                        )}
                    </>
                )}

                {tab === 'batches' &&
                    (loading ? (
                        <p className="muted">Loading…</p>
                    ) : (
                        <div className="inv-table-wrap">
                            <table className="packages">
                                <thead>
                                    <tr>
                                        <th>Created</th>
                                        <th>Status</th>
                                        <th>Requests</th>
                                        <th>Note</th>
                                        <th>Created by</th>
                                        <th>Actions</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {batches.map((b) => (
                                        <tr key={b.id}>
                                            <td className="muted small">{fmtDate(b.created_at)}</td>
                                            <td>
                                                <StatusChip status={b.status} />
                                            </td>
                                            <td>{b.request_count}</td>
                                            <td>{b.note || '—'}</td>
                                            <td className="muted small">{b.created_by || '—'}</td>
                                            <td className="admin-row-actions">
                                                <button
                                                    type="button"
                                                    className="chip chip-tool"
                                                    disabled={busy}
                                                    onClick={() => openBatch(b.id)}
                                                >
                                                    Open
                                                </button>
                                                {b.status === 'draft' && (
                                                    <button
                                                        type="button"
                                                        className="chip chip-tool"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            runAction(
                                                                () => submitBatch(b.id),
                                                                'Batch submitted to supply / super admin'
                                                            )
                                                        }
                                                    >
                                                        Submit to supply
                                                    </button>
                                                )}
                                                {b.status === 'submitted' && isSuper && (
                                                    <button
                                                        type="button"
                                                        className="btn-primary"
                                                        disabled={busy}
                                                        onClick={() =>
                                                            runAction(() => sendBatch(b.id), 'Batch marked sent')
                                                        }
                                                    >
                                                        Mark sent
                                                    </button>
                                                )}
                                                {(b.status === 'draft' || b.status === 'submitted') && (
                                                    <button
                                                        type="button"
                                                        className="chip chip-tool"
                                                        disabled={busy}
                                                        onClick={() => {
                                                            const reason = window.prompt(
                                                                'Cancel reason (optional):'
                                                            );
                                                            if (reason === null) return;
                                                            return runAction(
                                                                () => cancelBatch(b.id, reason || null),
                                                                'Batch cancelled; requests returned to approved'
                                                            );
                                                        }}
                                                    >
                                                        Cancel batch
                                                    </button>
                                                )}
                                            </td>
                                        </tr>
                                    ))}
                                    {!batches.length && (
                                        <tr>
                                            <td colSpan={6} className="muted">
                                                No batches yet. Approve requests and combine them from the queue.
                                            </td>
                                        </tr>
                                    )}
                                </tbody>
                            </table>
                        </div>
                    ))}

                {detail && detailKind === 'request' && (
                    <RequestDetail
                        request={detail}
                        busy={busy}
                        onClose={() => {
                            setDetail(null);
                            setDetailKind(null);
                        }}
                        onApprove={() => runAction(() => approve(detail.id), 'Request approved')}
                        onCancel={() => {
                            const reason = window.prompt('Cancel reason (optional):');
                            if (reason === null) return;
                            return runAction(
                                () => cancelRequest(detail.id, reason || null),
                                'Request cancelled'
                            );
                        }}
                    />
                )}

                {detail && detailKind === 'batch' && (
                    <BatchDetail
                        batch={detail}
                        busy={busy}
                        isSuper={isSuper}
                        onClose={() => {
                            setDetail(null);
                            setDetailKind(null);
                        }}
                        onSubmit={() =>
                            runAction(() => submitBatch(detail.id), 'Batch submitted to supply / super admin')
                        }
                        onSend={() => runAction(() => sendBatch(detail.id), 'Batch marked sent')}
                        onCancel={() => {
                            const reason = window.prompt('Cancel reason (optional):');
                            if (reason === null) return;
                            return runAction(
                                () => cancelBatch(detail.id, reason || null),
                                'Batch cancelled; requests returned to approved'
                            );
                        }}
                    />
                )}
            </main>
        </>
    );
}

function RequestDetail({ request, busy, onClose, onApprove, onCancel }) {
    return (
        <section className="nexus-card mreq-detail">
            <div className="row-between">
                <div>
                    <p className="eyebrow-lite">Request</p>
                    <h2 className="card-title-demoted">
                        <code className="mreq-code">{request.id}</code> <StatusChip status={request.status} />
                    </h2>
                </div>
                <button type="button" className="chip chip-tool" onClick={onClose}>
                    Close
                </button>
            </div>
            <dl className="mreq-meta">
                <div>
                    <dt>Requester</dt>
                    <dd>
                        {request.requester_name}
                        <br />
                        <span className="muted small">{request.requester_contact}</span>
                    </dd>
                </div>
                <div>
                    <dt>Location</dt>
                    <dd>{request.location_text || '—'}</dd>
                </div>
                <div>
                    <dt>Needed by</dt>
                    <dd>{request.needed_by || '—'}</dd>
                </div>
                <div>
                    <dt>Submitted</dt>
                    <dd>{fmtDate(request.created_at)}</dd>
                </div>
            </dl>
            {request.notes && <p className="muted small">Notes: {request.notes}</p>}
            <table className="packages">
                <thead>
                    <tr>
                        <th>Material</th>
                        <th>Qty</th>
                        <th>Unit</th>
                    </tr>
                </thead>
                <tbody>
                    {(request.lines || []).map((line) => (
                        <tr key={line.id}>
                            <td>
                                {line.material_name}
                                {line.is_custom ? (
                                    <span className="muted small"> · custom</span>
                                ) : null}
                            </td>
                            <td>{line.quantity}</td>
                            <td>{line.unit}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {(request.status === 'submitted' || request.status === 'approved') && (
                <div className="form-actions mreq-actions">
                    {request.status === 'submitted' && (
                        <button type="button" className="btn-primary" disabled={busy} onClick={onApprove}>
                            Approve
                        </button>
                    )}
                    <button type="button" className="chip chip-tool" disabled={busy} onClick={onCancel}>
                        Cancel request
                    </button>
                </div>
            )}
        </section>
    );
}

function BatchDetail({ batch, busy, isSuper, onClose, onSubmit, onSend, onCancel }) {
    return (
        <section className="nexus-card mreq-detail">
            <div className="row-between">
                <div>
                    <p className="eyebrow-lite">Batch</p>
                    <h2 className="card-title-demoted">
                        <code className="mreq-code">{batch.id}</code> <StatusChip status={batch.status} />
                    </h2>
                </div>
                <button type="button" className="chip chip-tool" onClick={onClose}>
                    Close
                </button>
            </div>
            <p className="muted small">
                {batch.note ? `Note: ${batch.note}` : 'No batch note.'} · Created by {batch.created_by || '—'}{' '}
                on {fmtDate(batch.created_at)}
            </p>
            {(batch.requests || []).map((r) => (
                <div key={r.id} className="mreq-batch-req">
                    <div className="row-between">
                        <strong>{r.requester_name}</strong>
                        <span className="muted small">{r.location_text || '—'}</span>
                    </div>
                    <ul className="mreq-line-list">
                        {(r.lines || []).map((line) => (
                            <li key={line.id}>
                                {line.material_name}
                                {line.is_custom ? ' (custom)' : ''} — {line.quantity} {line.unit}
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
            <div className="form-actions mreq-actions">
                {batch.status === 'draft' && (
                    <button type="button" className="btn-primary" disabled={busy} onClick={onSubmit}>
                        Submit to supply
                    </button>
                )}
                {batch.status === 'submitted' && isSuper && (
                    <button type="button" className="btn-primary" disabled={busy} onClick={onSend}>
                        Mark sent
                    </button>
                )}
                {(batch.status === 'draft' || batch.status === 'submitted') && (
                    <button type="button" className="chip chip-tool" disabled={busy} onClick={onCancel}>
                        Cancel batch
                    </button>
                )}
            </div>
        </section>
    );
}
