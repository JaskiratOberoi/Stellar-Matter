import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { Topbar } from '../components/Topbar.jsx';

// Delivery sites: the inventory locations we dispatch to, with the address,
// contact person and drug licence that a dispatch challan and receiving slip
// start from. Saved on the location itself, so picking the site at dispatch
// is all it takes.

const KIND_LABEL = { business_unit: 'BU', lab: 'Lab', store: 'Warehouse' };
const KIND_FILTERS = [
    { key: 'all', label: 'All' },
    { key: 'business_unit', label: 'BUs' },
    { key: 'lab', label: 'Labs' },
    { key: 'store', label: 'Warehouses' }
];

const KIND_ORDER = { store: 0, business_unit: 1, lab: 2 };
const bySite = (a, b) => (KIND_ORDER[a.kind] ?? 3) - (KIND_ORDER[b.kind] ?? 3) || a.name.localeCompare(b.name);

export function AdminDeliverySitesPage() {
    const [sites, setSites] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [query, setQuery] = useState('');
    const [kind, setKind] = useState('all');
    const [missingOnly, setMissingOnly] = useState(false);
    const [editing, setEditing] = useState(null);
    const [creating, setCreating] = useState(false);

    const reload = useCallback(async () => {
        setErr(null);
        try {
            const r = await apiFetch('/api/inventory/locations');
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            setSites(j.locations || []);
        } catch (e) {
            setErr(String(e.message || e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    const withAddress = sites.filter((s) => s.address).length;

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return sites.filter((s) => {
            if (kind !== 'all' && s.kind !== kind) return false;
            if (missingOnly && s.address) return false;
            if (!q) return true;
            return [s.name, s.bu_code, s.client_code, s.address, s.contact_name, s.contact_phone]
                .filter(Boolean)
                .some((v) => String(v).toLowerCase().includes(q));
        });
    }, [sites, query, kind, missingOnly]);

    return (
        <>
            <Topbar onOrgSwitched={() => reload()} />
            <main className="admin-shell">
                <header className="admin-header row-between">
                    <div>
                        <p className="eyebrow">Admin</p>
                        <h1 className="wordmark">Delivery sites</h1>
                        <p className="muted small">
                            Where we send materials, and who receives them. A dispatch challan and receiving slip
                            start from the site's address, contact and D.L. number.
                        </p>
                    </div>
                    <div className="dsite-head-side">
                        <p className="dsite-count" aria-live="polite">
                            <strong>{withAddress}</strong>
                            <span className="muted small"> of {sites.length} sites have an address</span>
                        </p>
                        <button
                            type="button"
                            className="btn-primary"
                            aria-expanded={creating ? 'true' : 'false'}
                            onClick={() => {
                                setCreating((v) => !v);
                                setEditing(null);
                            }}
                        >
                            {creating ? 'Cancel' : 'New site'}
                        </button>
                    </div>
                </header>

                {creating && (
                    <div className="nexus-card dsite-new">
                        <SiteForm
                            onCancel={() => setCreating(false)}
                            onSaved={(created) => {
                                setSites((list) => [...list, created].sort(bySite));
                                setCreating(false);
                                setQuery(created.name);
                                setKind('all');
                                setMissingOnly(false);
                            }}
                        />
                    </div>
                )}

                <div className="dsite-filters">
                    <input
                        type="search"
                        className="dsite-search"
                        placeholder="Search name, code, address, contact"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label="Search delivery sites"
                    />
                    <div className="dsite-chips" role="group" aria-label="Site type">
                        {KIND_FILTERS.map((f) => (
                            <button
                                key={f.key}
                                type="button"
                                className="chip chip-tool"
                                aria-pressed={kind === f.key ? 'true' : 'false'}
                                onClick={() => setKind(f.key)}
                            >
                                {f.label}
                            </button>
                        ))}
                        <button
                            type="button"
                            className="chip chip-tool"
                            aria-pressed={missingOnly ? 'true' : 'false'}
                            onClick={() => setMissingOnly((v) => !v)}
                        >
                            No address yet
                        </button>
                    </div>
                </div>

                {err && <div className="results-error nexus-card">{err}</div>}

                {loading ? (
                    <p className="muted">Loading…</p>
                ) : (
                    <ul className="dsite-list">
                        {shown.map((s) => (
                            <li key={s.id} className="dsite-item">
                                {editing === s.id ? (
                                    <SiteForm
                                        site={s}
                                        onCancel={() => setEditing(null)}
                                        onSaved={(updated) => {
                                            setSites((list) => list.map((x) => (x.id === updated.id ? updated : x)));
                                            setEditing(null);
                                        }}
                                    />
                                ) : (
                                    <SiteRow site={s} onEdit={() => setEditing(s.id)} />
                                )}
                            </li>
                        ))}
                        {!shown.length && <li className="muted dsite-empty">No sites match.</li>}
                    </ul>
                )}
            </main>
        </>
    );
}

function SiteRow({ site, onEdit }) {
    const contact = [site.contact_name, site.contact_phone].filter(Boolean).join(' · ');
    return (
        <div className="dsite-row">
            <div className="dsite-name">
                <span className="dsite-title">{site.name}</span>
                <span className="dsite-meta muted small">
                    {KIND_LABEL[site.kind] || site.kind}
                    {site.bu_code && site.bu_code !== site.name ? ` · ${site.bu_code}` : ''}
                    {site.client_code ? ` · ${site.client_code}` : ''}
                </span>
            </div>
            <div className="dsite-address">
                {site.address ? (
                    <span className="dsite-pre">{site.address}</span>
                ) : (
                    <span className="muted small">No address yet</span>
                )}
            </div>
            <div className="dsite-contact small">
                {contact ? <span>{contact}</span> : <span className="muted">No contact</span>}
                {site.licence_no && <span className="muted">D.L. {site.licence_no}</span>}
            </div>
            <button type="button" className="chip chip-tool dsite-edit" onClick={onEdit}>
                {site.address ? 'Edit' : 'Add details'}
            </button>
        </div>
    );
}

// Edits a site's delivery details, or (without `site`) adds a new site.
function SiteForm({ site, onCancel, onSaved }) {
    const isNew = !site;
    const [f, setF] = useState({
        name: '',
        kind: 'business_unit',
        address: (site && site.address) || '',
        contact_name: (site && site.contact_name) || '',
        contact_phone: (site && site.contact_phone) || '',
        licence_no: (site && site.licence_no) || ''
    });
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const set = (k) => (e) => setF((v) => ({ ...v, [k]: e.target.value }));

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            const { name, kind, ...details } = f;
            const r = isNew
                ? await apiFetch('/api/inventory/locations', {
                      method: 'POST',
                      body: JSON.stringify({ name: name.trim(), kind, ...details })
                  })
                : await apiFetch(`/api/inventory/locations/${site.id}`, {
                      method: 'PATCH',
                      body: JSON.stringify(details)
                  });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onSaved(j.location);
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form
            className="org-challan-form dsite-form"
            onSubmit={onSubmit}
            onKeyDown={(e) => {
                if (e.key === 'Escape') onCancel();
            }}
        >
            {isNew ? (
                <div className="org-challan-row">
                    <label className="dsite-span2">
                        Site name
                        <input value={f.name} onChange={set('name')} required autoFocus autoComplete="off" placeholder="As it should appear on the challan" />
                    </label>
                    <label>
                        Type
                        <select value={f.kind} onChange={set('kind')}>
                            <option value="business_unit">BU</option>
                            <option value="lab">Lab</option>
                            <option value="store">Warehouse</option>
                        </select>
                    </label>
                </div>
            ) : (
                <p className="dsite-title">{site.name}</p>
            )}
            <label>
                Delivery address
                <textarea
                    rows={3}
                    autoFocus={!isNew}
                    value={f.address}
                    onChange={set('address')}
                    placeholder="Full address as the courier should see it, with PIN"
                />
            </label>
            <div className="org-challan-row">
                <label>
                    Contact person
                    <input value={f.contact_name} onChange={set('contact_name')} autoComplete="off" />
                </label>
                <label>
                    Contact phone
                    <input type="tel" value={f.contact_phone} onChange={set('contact_phone')} autoComplete="off" />
                </label>
                <label>
                    Party D.L. No.
                    <input value={f.licence_no} onChange={set('licence_no')} autoComplete="off" />
                </label>
            </div>
            {err && <p className="login-err" role="alert">{err}</p>}
            <div className="form-actions">
                <button type="submit" className="btn-primary btn-sm" disabled={busy}>
                    {busy ? 'Saving…' : isNew ? 'Add site' : 'Save site'}
                </button>
                <button type="button" className="chip chip-tool" onClick={onCancel} disabled={busy}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
