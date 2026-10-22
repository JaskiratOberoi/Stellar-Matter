import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../apiClient.js';

// Every place the app can take you, gated by role. Material requests is left
// out until that page ships.
const PAGES = [
    { label: 'Stock on hand', hint: 'Inventory', to: '/' },
    { label: 'Receive stock', hint: 'Inventory', to: '/?tab=receive', roles: ['super_admin', 'admin', 'operator'] },
    { label: 'Dispatch stock', hint: 'Inventory', to: '/?tab=dispatch', roles: ['super_admin', 'admin', 'operator'] },
    { label: 'Ledger', hint: 'Inventory', to: '/?tab=ledger' },
    { label: 'Purchase orders', hint: 'Inventory', to: '/?tab=orders' },
    { label: 'Stock count', hint: 'Inventory', to: '/?tab=count', roles: ['super_admin', 'admin'] },
    { label: 'Vendors', hint: 'Inventory', to: '/?tab=vendors' },
    { label: 'Catalog', hint: 'Inventory', to: '/?tab=catalog', roles: ['super_admin', 'admin'] },
    { label: 'Consumption', hint: 'Inventory', to: '/?tab=consumption', roles: ['super_admin'] },
    { label: 'Tracer', hint: 'Demand from the LIS', to: '/tracer' },
    { label: 'Delivery sites', hint: 'Admin', to: '/admin/delivery-sites', roles: ['super_admin', 'admin', 'operator'] },
    { label: 'Users', hint: 'Admin', to: '/admin/users', roles: ['super_admin'] },
    { label: 'Organisations', hint: 'Admin', to: '/admin/orgs', roles: ['super_admin'] },
    { label: 'Audit trail', hint: 'Admin', to: '/admin/audit-log', roles: ['super_admin'] }
];

const RESULT_CAP = 8;

function score(label, q) {
    const l = label.toLowerCase();
    if (l === q) return 0;
    if (l.startsWith(q)) return 1;
    if (l.split(/[\s()/-]+/).some((w) => w.startsWith(q))) return 2;
    if (l.includes(q)) return 3;
    return null;
}

/**
 * Ctrl/Cmd+K: jump to a page, a material (its stock) or a site (its ledger)
 * from anywhere. Materials and sites load on first open and stay cached.
 */
export function CommandPalette({ role, open, onClose }) {
    const navigate = useNavigate();
    const inputRef = useRef(null);
    const [q, setQ] = useState('');
    const [active, setActive] = useState(0);
    const [data, setData] = useState(null);

    useEffect(() => {
        if (!open) return;
        setQ('');
        setActive(0);
        requestAnimationFrame(() => inputRef.current && inputRef.current.focus());
        if (data) return;
        const get = (url, key) =>
            apiFetch(url)
                .then((r) => (r.ok ? r.json() : {}))
                .then((j) => (Array.isArray(j[key]) ? j[key] : []))
                .catch(() => []);
        Promise.all([get('/api/inventory/materials', 'materials'), get('/api/inventory/locations', 'locations')]).then(
            ([materials, locations]) => setData({ materials, locations })
        );
    }, [open, data]);

    const groups = useMemo(() => {
        const query = q.trim().toLowerCase();
        const pages = PAGES.filter((p) => !p.roles || p.roles.includes(role)).map((p) => ({ ...p, kind: 'Page' }));
        const mats = ((data && data.materials) || [])
            .filter((m) => m.active)
            .map((m) => ({ label: m.name, hint: `${m.base_unit} · stock`, to: `/?q=${encodeURIComponent(m.name)}`, kind: 'Material' }));
        const sites = ((data && data.locations) || [])
            .filter((l) => l.active)
            .map((l) => ({
                label: l.name,
                hint: `${l.kind === 'store' ? 'store' : l.kind === 'lab' ? 'lab' : 'business unit'}${l.bu_code && l.bu_code.toLowerCase() !== l.name.toLowerCase() ? ` · ${l.bu_code}` : ''} · ledger`,
                keys: [l.bu_code, l.client_code].filter(Boolean),
                to: `/?tab=ledger&location=${encodeURIComponent(l.id)}`,
                kind: 'Site'
            }));
        const rank = (list) =>
            list
                .map((x) => {
                    const scores = [x.label, ...(x.keys || [])].map((s) => score(String(s), query)).filter((s) => s != null);
                    return scores.length ? { x, s: Math.min(...scores) } : null;
                })
                .filter(Boolean)
                .sort((a, b) => a.s - b.s || a.x.label.localeCompare(b.x.label))
                .slice(0, RESULT_CAP)
                .map((r) => r.x);
        if (!query) return [{ title: 'Go to', items: pages }];
        return [
            { title: 'Pages', items: rank(pages) },
            { title: 'Materials', items: rank(mats) },
            { title: 'Sites', items: rank(sites) }
        ].filter((g) => g.items.length);
    }, [q, data, role]);
    const flat = groups.flatMap((g) => g.items);

    useEffect(() => setActive(0), [q]);

    if (!open) return null;

    const go = (item) => {
        onClose();
        navigate(item.to);
    };

    let i = -1;
    return createPortal(
        <div className="cmdk-root" onMouseDown={onClose}>
            <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search" onMouseDown={(e) => e.stopPropagation()}>
                <input
                    ref={inputRef}
                    className="cmdk-input"
                    placeholder="Search pages, materials, sites or codes…"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'ArrowDown') {
                            e.preventDefault();
                            setActive((a) => Math.min(a + 1, flat.length - 1));
                        } else if (e.key === 'ArrowUp') {
                            e.preventDefault();
                            setActive((a) => Math.max(a - 1, 0));
                        } else if (e.key === 'Enter') {
                            e.preventDefault();
                            if (flat[active]) go(flat[active]);
                        } else if (e.key === 'Escape') {
                            onClose();
                        }
                    }}
                    role="combobox"
                    aria-expanded="true"
                    aria-autocomplete="list"
                    autoComplete="off"
                />
                <div className="cmdk-list" role="listbox">
                    {groups.map((g) => (
                        <div key={g.title} className="cmdk-group">
                            <p className="cmdk-group-title">{g.title}</p>
                            {g.items.map((item) => {
                                i += 1;
                                const idx = i;
                                return (
                                    <button
                                        key={`${g.title}:${item.to}`}
                                        type="button"
                                        role="option"
                                        aria-selected={idx === active ? 'true' : 'false'}
                                        className={`cmdk-item${idx === active ? ' is-active' : ''}`}
                                        onMouseEnter={() => setActive(idx)}
                                        onClick={() => go(item)}
                                    >
                                        <span className="cmdk-label">{item.label}</span>
                                        <span className="cmdk-hint">{item.hint}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ))}
                    {q.trim() && !flat.length && (
                        <p className="cmdk-empty">{data ? `Nothing matches “${q.trim()}”.` : 'Loading materials and sites…'}</p>
                    )}
                </div>
                <p className="cmdk-foot">
                    <kbd>↑</kbd> <kbd>↓</kbd> to move · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
                </p>
            </div>
        </div>,
        document.body
    );
}
