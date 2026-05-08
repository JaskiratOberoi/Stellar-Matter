import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../apiClient.js';

const ACTION_GROUPS = [
    { id: '', label: 'All actions' },
    { id: 'auth.', label: 'Authentication' },
    { id: 'admin.user.', label: 'User management' },
    { id: 'run.', label: 'Run starts' }
];

const OUTCOMES = [
    { id: '', label: 'All outcomes' },
    { id: 'success', label: 'Success' },
    { id: 'failure', label: 'Failure' }
];

function fmtTime(iso) {
    if (!iso) return '—';
    try {
        return new Date(iso).toLocaleString();
    } catch {
        return String(iso);
    }
}

export function AdminAuditLogPage() {
    const [entries, setEntries] = useState([]);
    const [actionFilter, setActionFilter] = useState('');
    const [outcomeFilter, setOutcomeFilter] = useState('');
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [nextCursor, setNextCursor] = useState(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [expandedId, setExpandedId] = useState(null);

    const load = useCallback(
        async ({ append } = {}) => {
            if (append) setLoadingMore(true);
            else {
                setLoading(true);
                setErr(null);
            }
            try {
                const params = new URLSearchParams();
                params.set('limit', '50');
                if (actionFilter) params.set('action', actionFilter);
                if (outcomeFilter) params.set('outcome', outcomeFilter);
                if (append && nextCursor != null) params.set('before_id', String(nextCursor));
                const r = await apiFetch(`/api/admin/audit-log?${params.toString()}`);
                if (!r.ok) {
                    const j = await r.json().catch(() => ({}));
                    throw new Error(j.error || `HTTP ${r.status}`);
                }
                const j = await r.json();
                setEntries((prev) => (append ? [...prev, ...(j.entries || [])] : j.entries || []));
                setNextCursor(j.next_cursor != null ? j.next_cursor : null);
            } catch (e) {
                setErr(String(e.message || e));
            } finally {
                if (append) setLoadingMore(false);
                else setLoading(false);
            }
        },
        [actionFilter, outcomeFilter, nextCursor]
    );

    // Reset cursor + reload when filters change.
    useEffect(() => {
        setNextCursor(null);
        load({ append: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actionFilter, outcomeFilter]);

    const grouped = useMemo(() => entries, [entries]);

    return (
        <main className="admin-shell">
            <header className="admin-header row-between">
                <div>
                    <p className="eyebrow">Admin</p>
                    <h1 className="wordmark">Audit log</h1>
                    <p className="muted small">
                        Append-only record of logins, admin user mutations, and run starts. Actor, target,
                        before/after snapshots are captured for diffing.
                    </p>
                </div>
                <div className="admin-actions">
                    <Link to="/" className="chip chip-tool">
                        ← Back to dashboard
                    </Link>
                    <Link to="/admin/users" className="chip chip-tool">
                        Users
                    </Link>
                </div>
            </header>

            <div className="audit-toolbar nexus-card">
                <label className="audit-filter">
                    <span className="muted small">Action</span>
                    <select value={actionFilter} onChange={(e) => setActionFilter(e.target.value)}>
                        {ACTION_GROUPS.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.label}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="audit-filter">
                    <span className="muted small">Outcome</span>
                    <select value={outcomeFilter} onChange={(e) => setOutcomeFilter(e.target.value)}>
                        {OUTCOMES.map((o) => (
                            <option key={o.id} value={o.id}>
                                {o.label}
                            </option>
                        ))}
                    </select>
                </label>
                <button
                    type="button"
                    className="chip chip-tool"
                    onClick={() => load({ append: false })}
                    disabled={loading}
                >
                    {loading ? 'Loading…' : 'Refresh'}
                </button>
            </div>

            {err && <div className="results-error nexus-card">{err}</div>}

            {loading && !grouped.length ? (
                <p className="muted">Loading…</p>
            ) : (
                <table className="packages admin-audit-table">
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Action</th>
                            <th>Actor</th>
                            <th>Target</th>
                            <th>Outcome</th>
                            <th>IP</th>
                            <th aria-label="expand" />
                        </tr>
                    </thead>
                    <tbody>
                        {grouped.map((e) => (
                            <AuditRow
                                key={e.id}
                                entry={e}
                                expanded={expandedId === e.id}
                                onToggle={() => setExpandedId((prev) => (prev === e.id ? null : e.id))}
                            />
                        ))}
                        {!grouped.length && (
                            <tr>
                                <td colSpan={7} className="muted">
                                    No audit entries match this filter.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            )}

            {nextCursor != null && (
                <div className="audit-loadmore">
                    <button
                        type="button"
                        className="chip chip-tool"
                        onClick={() => load({ append: true })}
                        disabled={loadingMore}
                    >
                        {loadingMore ? 'Loading…' : 'Load older entries'}
                    </button>
                </div>
            )}
        </main>
    );
}

function AuditRow({ entry, expanded, onToggle }) {
    const outcomeChip = entry.outcome === 'failure' ? 'env-big' : 'env-small';
    return (
        <>
            <tr className={expanded ? 'rank-1' : ''}>
                <td className="muted small">{fmtTime(entry.created_at)}</td>
                <td className="label">{entry.action}</td>
                <td className="muted small">{entry.actor_username || entry.actor_id || '—'}</td>
                <td className="muted small">
                    {entry.target_type ? `${entry.target_type}:${entry.target_id || '—'}` : '—'}
                </td>
                <td>
                    <span className={`env-chip ${outcomeChip}`}>{entry.outcome}</span>
                </td>
                <td className="muted small">{entry.ip || '—'}</td>
                <td>
                    <button type="button" className="chip chip-tool" onClick={onToggle}>
                        {expanded ? 'Hide' : 'Details'}
                    </button>
                </td>
            </tr>
            {expanded && (
                <tr>
                    <td colSpan={7} className="audit-detail-cell">
                        <div className="audit-detail">
                            {entry.before && (
                                <div>
                                    <p className="eyebrow-lite">before</p>
                                    <pre className="audit-json">{JSON.stringify(entry.before, null, 2)}</pre>
                                </div>
                            )}
                            {entry.after && (
                                <div>
                                    <p className="eyebrow-lite">after</p>
                                    <pre className="audit-json">{JSON.stringify(entry.after, null, 2)}</pre>
                                </div>
                            )}
                            {entry.metadata && (
                                <div>
                                    <p className="eyebrow-lite">metadata</p>
                                    <pre className="audit-json">{JSON.stringify(entry.metadata, null, 2)}</pre>
                                </div>
                            )}
                            {entry.user_agent && (
                                <p className="muted small">
                                    user-agent: <code>{entry.user_agent}</code>
                                </p>
                            )}
                        </div>
                    </td>
                </tr>
            )}
        </>
    );
}
