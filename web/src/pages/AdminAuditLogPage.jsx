import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { Topbar } from '../components/Topbar.jsx';
import { ActorHoverCard, describeUserAgent, formatGeo } from '../components/ActorHoverCard.jsx';

const ACTION_GROUPS = [
    { id: '', label: 'All actions' },
    { id: 'inventory.', label: 'Inventory' },
    { id: 'tracer-run.', label: 'Tracer runs' },
    { id: 'auth.', label: 'Sign-ins' },
    { id: 'admin.user.', label: 'Users' },
    { id: 'admin.org.', label: 'Organisations' },
    { id: 'material_request.', label: 'Material requests' },
    { id: 'api.', label: 'Automatic API records' }
];

const OUTCOMES = [
    { id: '', label: 'Any outcome' },
    { id: 'success', label: 'Succeeded' },
    { id: 'failure', label: 'Failed' }
];

const RANGES = [
    { id: 'today', label: 'Today', days: 0 },
    { id: '7d', label: '7 days', days: 6 },
    { id: '30d', label: '30 days', days: 29 },
    { id: 'all', label: 'All time', days: null }
];

function startOfDay(offsetDays = 0) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDays);
    return d;
}

function fmtClock(iso) {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown date';
    const today = startOfDay(0).getTime();
    const day = new Date(d).setHours(0, 0, 0, 0);
    if (day === today) return 'Today';
    if (day === today - 86400000) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
}

const isAuto = (e) => Boolean(e.metadata && (e.metadata.auto === true || e.metadata.auto === 'true'));
const plural = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString()} ${Number(n) === 1 ? one : many}`;
const REASONS = { bad_password: 'wrong password', unknown_user: 'unknown username', account_disabled: 'account deactivated', not_assigned: 'not in that organisation' };
const VERBS = { create: 'Created', update: 'Updated', delete: 'Deleted', void: 'Voided', sync: 'Synced', submit: 'Submitted' };

/**
 * One plain sentence for an audit row: what happened, to what. Ids resolve to
 * names through `names` (locations, materials, users) where the page knows them.
 */
function describe(e, names) {
    const a = e.after || {};
    const b = e.before || {};
    const md = e.metadata || {};
    const loc = (id) => (id ? names.loc(id) : null);
    const [area, type, verbRaw] = String(e.action || '').split('.');
    const verb = VERBS[verbRaw] || VERBS[type] || null;

    switch (e.action) {
        case 'auth.login':
            return e.outcome === 'failure'
                ? `Failed sign-in${md.username ? ` as ${md.username}` : ''}${md.reason ? ` (${REASONS[md.reason] || String(md.reason).replace(/_/g, ' ')})` : ''}`
                : 'Signed in';
        case 'auth.logout':
            return 'Signed out';
        case 'auth.switch_org':
            return 'Switched organisation';
        case 'inventory.movement.batch':
        case 'inventory.movement.create': {
            if (e.outcome === 'failure') return `A ${a.kind || 'stock'} entry was refused${md.reason ? ` (${String(md.reason).replace(/_/g, ' ')})` : ''}`;
            const lines = a.lines || a.movements || 1;
            const from = loc(a.from_location_id);
            const to = a.to_all_bus ? 'every business unit and lab' : loc(a.to_location_id);
            if (a.kind === 'receipt') return `Received ${plural(lines, 'material')} into ${to || 'a store'}`;
            if (a.kind === 'adjustment') return `Adjusted ${plural(lines, 'material')} ${a.to_location_id ? 'up at' : 'down at'} ${to || from || 'a site'}`;
            return `Dispatched ${plural(lines, 'material')}: ${from || '?'} → ${to || '?'}${md.allow_negative ? ' (overdraw allowed)' : ''}`;
        }
        case 'inventory.movement.void':
            return `Voided ledger entry #${e.target_id || '?'}${md.allow_negative ? ' (forced)' : ''}`;
        case 'inventory.location.sync':
            return `Added ${plural((a.added || []).length, 'new site')} from the LIS`;
        case 'tracer-run.start': {
            const scope = [];
            if (Array.isArray(md.business_units) && md.business_units.length) {
                scope.push(md.business_units.length <= 3 ? md.business_units.join(', ') : plural(md.business_units.length, 'business unit'));
            }
            if (Array.isArray(md.sales_people) && md.sales_people.length) scope.push(plural(md.sales_people.length, 'salesperson', 'salespeople'));
            if (Array.isArray(md.bu_groups) && md.bu_groups.length) scope.push(plural(md.bu_groups.length, 'region'));
            if (Array.isArray(md.client_codes) && md.client_codes.length) scope.push(plural(md.client_codes.length, 'client code'));
            const window = md.from_date ? ` · ${md.from_date}${md.to_date && md.to_date !== md.from_date ? ` → ${md.to_date}` : ''}` : '';
            return `Ran the Tracer${scope.length ? `: ${scope.join(', ')}` : ''}${window}${md.collate ? ' (merged)' : ''}`;
        }
        case 'tracer-run.cancel':
            return 'Stopped a Tracer run';
        case 'run.start':
            return 'Started a run (legacy tool)';
        default:
            break;
    }
    if (area === 'api') {
        return `${e.method || String(type || '').toUpperCase()} ${e.path || e.target_id || ''}`.trim();
    }
    const subject =
        a.name || b.name || a.username || b.username || a.reference || b.reference || a.display_name || b.display_name || null;
    const what = {
        location: 'site',
        material: 'material',
        vendor: 'vendor',
        order: 'purchase order',
        user: 'user',
        org: 'organisation'
    }[type] || String(type || area || 'item').replace(/_/g, ' ');
    if (verb) return `${verb} ${what}${subject ? ` “${subject}”` : e.target_id ? ` ${names.user(e.target_id) || e.target_id}` : ''}`;
    return String(e.action || 'Unknown action').replace(/[._]/g, ' ');
}

const fieldLabel = (k) => k.replace(/_id$/, '').replace(/_/g, ' ');

// Field-level view of what changed. Ids that name a location or user are
// shown as names; long values are trimmed for the table.
function fieldValue(key, v, names) {
    if (v == null || v === '') return '—';
    if (/location_id$/.test(key)) return names.loc(v) || String(v);
    if (/(^|_)user_id$|created_by|actor_id/.test(key)) return names.user(v) || String(v);
    if (/material_id$/.test(key)) return names.mat(v) || String(v);
    if (typeof v === 'boolean') return v ? 'yes' : 'no';
    if (/_at$/.test(key) && !Number.isNaN(Date.parse(v))) return new Date(v).toLocaleString();
    if (Array.isArray(v)) return v.length > 6 ? `${v.slice(0, 6).join(', ')} … (+${v.length - 6})` : v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
}

function ChangeTable({ entry, names }) {
    const before = entry.before || {};
    const after = entry.after || {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    if (!keys.length) return null;
    const both = entry.before && entry.after;
    return (
        <table className="audit-changes">
            <thead>
                <tr>
                    <th>Field</th>
                    {both && <th>Before</th>}
                    <th>{both ? 'After' : entry.before ? 'Value (before)' : 'Value'}</th>
                </tr>
            </thead>
            <tbody>
                {keys.map((k) => {
                    const bv = fieldValue(k, before[k], names);
                    const av = fieldValue(k, after[k], names);
                    const changed = both && bv !== av;
                    return (
                        <tr key={k} className={changed ? 'is-changed' : undefined}>
                            <td className="audit-field">{fieldLabel(k)}</td>
                            {both && <td>{bv}</td>}
                            <td>{entry.after ? av : bv}</td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );
}

export function AdminAuditLogPage() {
    const [entries, setEntries] = useState([]);
    const [actionFilter, setActionFilter] = useState('');
    const [outcomeFilter, setOutcomeFilter] = useState('');
    const [actorFilter, setActorFilter] = useState('');
    const [range, setRange] = useState('7d');
    const [showAuto, setShowAuto] = useState(false);
    const [searchInput, setSearchInput] = useState('');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [nextCursor, setNextCursor] = useState(null);
    const [loadingMore, setLoadingMore] = useState(false);
    const [expandedId, setExpandedId] = useState(null);
    const [lookups, setLookups] = useState({ users: [], locations: [], materials: [] });

    // Names for ids that appear in entries. Best-effort: the trail still
    // reads (with ids) if any lookup fails.
    useEffect(() => {
        let alive = true;
        const get = (url, key) =>
            apiFetch(url)
                .then((r) => (r.ok ? r.json() : {}))
                .then((j) => (Array.isArray(j[key]) ? j[key] : []))
                .catch(() => []);
        Promise.all([
            get('/api/admin/users', 'users'),
            get('/api/inventory/locations?include_inactive=1', 'locations'),
            get('/api/inventory/materials?include_inactive=1', 'materials')
        ]).then(([users, locations, materials]) => {
            if (alive) setLookups({ users, locations, materials });
        });
        return () => {
            alive = false;
        };
    }, []);

    const names = useMemo(() => {
        const u = new Map(lookups.users.map((x) => [String(x.id), x.display_name || x.username]));
        const l = new Map(lookups.locations.map((x) => [String(x.id), x.name]));
        const m = new Map(lookups.materials.map((x) => [String(x.id), x.name]));
        return { user: (id) => u.get(String(id)), loc: (id) => l.get(String(id)), mat: (id) => m.get(String(id)) };
    }, [lookups]);

    const rangeFrom = useMemo(() => {
        const r = RANGES.find((x) => x.id === range);
        return r && r.days != null ? startOfDay(-r.days) : null;
    }, [range]);

    const load = useCallback(
        async ({ append } = {}) => {
            if (append) setLoadingMore(true);
            else {
                setLoading(true);
                setErr(null);
            }
            try {
                const params = new URLSearchParams();
                params.set('limit', '100');
                if (actionFilter) params.set('action', actionFilter);
                if (outcomeFilter) params.set('outcome', outcomeFilter);
                if (actorFilter) params.set('actor_id', actorFilter);
                if (rangeFrom) params.set('from', rangeFrom.toISOString());
                if (!showAuto && actionFilter !== 'api.') params.set('hide_auto', '1');
                if (search) params.set('q', search);
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
        [actionFilter, outcomeFilter, actorFilter, rangeFrom, showAuto, search, nextCursor]
    );

    useEffect(() => {
        setNextCursor(null);
        load({ append: false });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [actionFilter, outcomeFilter, actorFilter, rangeFrom, showAuto, search]);

    useEffect(() => {
        const t = setTimeout(() => setSearch(searchInput.trim()), 350);
        return () => clearTimeout(t);
    }, [searchInput]);

    // The same filters applied client-side too, so an API that predates the
    // date / automatic-record filters still shows the right rows.
    const shown = useMemo(
        () =>
            entries.filter(
                (e) =>
                    (showAuto || actionFilter === 'api.' || !isAuto(e)) &&
                    (!rangeFrom || new Date(e.created_at) >= rangeFrom)
            ),
        [entries, showAuto, actionFilter, rangeFrom]
    );

    const days = useMemo(() => {
        const out = [];
        for (const e of shown) {
            const label = dayLabel(e.created_at);
            const last = out[out.length - 1];
            if (last && last.label === label) last.items.push(e);
            else out.push({ label, items: [e] });
        }
        return out;
    }, [shown]);

    const people = useMemo(
        () => [...lookups.users].sort((x, y) => (x.display_name || x.username).localeCompare(y.display_name || y.username)),
        [lookups.users]
    );

    return (
        <>
            <Topbar onOrgSwitched={() => load()} />
            <main className="admin-shell">
                <header className="admin-header row-between">
                    <div>
                        <p className="eyebrow">Admin</p>
                        <h1 className="wordmark">Audit trail</h1>
                        <p className="muted small">
                            Every sign-in and every change, newest first. Open a row for what changed, from where and
                            on which device.
                        </p>
                    </div>
                </header>

                <div className="audit-toolbar nexus-card">
                    <div className="audit-ranges" role="radiogroup" aria-label="Date range">
                        {RANGES.map((r) => (
                            <button
                                key={r.id}
                                type="button"
                                role="radio"
                                aria-checked={range === r.id ? 'true' : 'false'}
                                className="chip chip-tool"
                                onClick={() => setRange(r.id)}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                    <label className="audit-filter">
                        <span className="muted small">Person</span>
                        <select value={actorFilter} onChange={(e) => setActorFilter(e.target.value)}>
                            <option value="">Anyone</option>
                            {people.map((u) => (
                                <option key={u.id} value={u.id}>
                                    {u.display_name || u.username}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label className="audit-filter">
                        <span className="muted small">Kind</span>
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
                    <label className="audit-filter audit-filter-search">
                        <span className="muted small">Search</span>
                        <input
                            type="search"
                            value={searchInput}
                            placeholder="user, action, IP or place"
                            onChange={(e) => setSearchInput(e.target.value)}
                        />
                    </label>
                    <label className="inv-toggle audit-auto-toggle">
                        <input
                            type="checkbox"
                            className="inv-toggle-input"
                            checked={showAuto}
                            onChange={(e) => setShowAuto(e.target.checked)}
                        />
                        <span className="inv-toggle-track" aria-hidden="true">
                            <span className="inv-toggle-thumb" />
                        </span>
                        <span className="inv-toggle-label">Show automatic records</span>
                    </label>
                </div>

                {err && <div className="results-error nexus-card">{err}</div>}

                {loading && !shown.length ? (
                    <p className="muted">Loading…</p>
                ) : !shown.length ? (
                    <p className="muted audit-empty">Nothing recorded for these filters.</p>
                ) : (
                    days.map((d) => (
                        <section key={d.label} className="audit-day">
                            <h2 className="audit-day-head">
                                {d.label}
                                <span className="muted small">{plural(d.items.length, 'entry', 'entries')}</span>
                            </h2>
                            <ul className="audit-list">
                                {d.items.map((e) => (
                                    <AuditItem
                                        key={e.id}
                                        entry={e}
                                        names={names}
                                        expanded={expandedId === e.id}
                                        onToggle={() => setExpandedId((prev) => (prev === e.id ? null : e.id))}
                                    />
                                ))}
                            </ul>
                        </section>
                    ))
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
        </>
    );
}

function AuditItem({ entry, names, expanded, onToggle }) {
    const failed = entry.outcome === 'failure';
    const place = formatGeo(entry.geo);
    const device = describeUserAgent(entry.user_agent);
    const sentence = describe(entry, names);
    const md = entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : null;
    return (
        <li className={`audit-item${failed ? ' is-failure' : ''}${isAuto(entry) ? ' is-auto' : ''}${expanded ? ' is-open' : ''}`}>
            <button type="button" className="audit-item-row" aria-expanded={expanded ? 'true' : 'false'} onClick={onToggle}>
                <span className="audit-time">{fmtClock(entry.created_at)}</span>
                <span className="audit-what">
                    <span className="audit-sentence">{sentence}</span>
                    <span className="audit-code">{entry.action}</span>
                </span>
                <span className="audit-who" onClick={(ev) => ev.stopPropagation()}>
                    {entry.actor_username || entry.actor_id ? <ActorHoverCard entry={entry} /> : 'anonymous'}
                </span>
                <span className="audit-where">{place || entry.ip || '—'}</span>
                <span className="audit-flag">
                    {failed && <span className="env-chip audit-outcome is-failure">failed{entry.status_code ? ` ${entry.status_code}` : ''}</span>}
                </span>
            </button>
            {expanded && (
                <div className="audit-detail">
                    <ChangeTable entry={entry} names={names} />
                    {md && Object.keys(md).length > 0 && (
                        <dl className="audit-meta">
                            {Object.entries(md).map(([k, v]) => (
                                <div key={k}>
                                    <dt>{fieldLabel(k)}</dt>
                                    <dd>{fieldValue(k, v, names)}</dd>
                                </div>
                            ))}
                        </dl>
                    )}
                    <p className="muted small audit-origin">
                        {[entry.ip, place, device, entry.method && entry.path ? `${entry.method} ${entry.path}` : null]
                            .filter(Boolean)
                            .join(' · ') || 'No origin recorded'}
                    </p>
                    <details className="audit-raw">
                        <summary>Raw record</summary>
                        <pre className="audit-json">
                            {JSON.stringify(
                                { before: entry.before, after: entry.after, metadata: entry.metadata, geo: entry.geo, user_agent: entry.user_agent },
                                null,
                                2
                            )}
                        </pre>
                    </details>
                </div>
            )}
        </li>
    );
}
