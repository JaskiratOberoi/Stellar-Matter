import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export function Topbar({ statusPill, lastUpdated, onOrgSwitched }) {
    const { user, orgs, authRequired, logout, switchOrg } = useAuth();
    const location = useLocation();
    const isInventory = location.pathname.startsWith('/inventory');

    return (
        <header className="topbar" role="banner">
            <div className="topbar-bar">
                <div className="topbar-left">
                    <div className="topbar-brand">
                        <div className="topbar-brand-text">
                            <h1 className="wordmark">Stellar Matter</h1>
                            <p className="topbar-tagline">Official tally for materials in Genomics</p>
                        </div>
                        {!isInventory ? (
                            <Link
                                to="/inventory"
                                className="chip chip-tool tracer-ui-link"
                                title="Open the inventory tracker"
                            >
                                Inventory
                            </Link>
                        ) : (
                            <Link to="/" className="chip chip-tool tracer-ui-link" title="Return to Tracer">
                                ← Tracer
                            </Link>
                        )}
                    </div>
                </div>
                <div className="topbar-right">
                    {statusPill && <span className={`status-pill ${statusPill.kind}`}>{statusPill.text}</span>}
                    {lastUpdated && (
                        <span className="last-updated" aria-live="polite">
                            Updated{' '}
                            {lastUpdated.toLocaleTimeString(undefined, {
                                hour: '2-digit',
                                minute: '2-digit',
                                second: '2-digit'
                            })}
                        </span>
                    )}
                    {authRequired && user && (
                        <span className="user-chip">
                            <OrgSwitcher
                                user={user}
                                orgs={orgs}
                                onSwitch={async (orgId) => {
                                    const r = await switchOrg(orgId);
                                    if (r.ok && typeof onOrgSwitched === 'function') onOrgSwitched(orgId);
                                    else if (!r.ok) window.alert(r.error || 'Org switch failed');
                                }}
                            />
                            {user.role === 'super_admin' && (
                                <>
                                    <Link to="/admin/users" className="chip chip-tool admin-nav-link">
                                        Users
                                    </Link>
                                    <Link to="/admin/orgs" className="chip chip-tool admin-nav-link">
                                        Orgs
                                    </Link>
                                    <Link to="/admin/audit-log" className="chip chip-tool admin-nav-link">
                                        Audit log
                                    </Link>
                                </>
                            )}
                            <span className="topbar-user-name">
                                {user.display_name || user.username}
                                {user.role === 'super_admin' && ' \u00b7 super admin'}
                                {user.role === 'admin' && ' \u00b7 admin'}
                            </span>
                            <button type="button" className="chip chip-tool user-logout" onClick={logout}>
                                Log out
                            </button>
                        </span>
                    )}
                </div>
            </div>
        </header>
    );
}

function OrgSwitcher({ user, orgs, onSwitch }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);

    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (e) => {
            if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
        };
        const onKeyDown = (e) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.removeEventListener('pointerdown', onPointerDown);
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [open]);

    if (!orgs || orgs.length === 0) return null;
    const active = orgs.find((o) => o.id === user.active_org_id) || null;
    const activeLabel = active ? active.name : '— no org —';
    const canSwitch = orgs.length > 1 || user.role === 'super_admin';
    if (!canSwitch) {
        return (
            <span className="chip chip-tool org-chip-static" title={`Active org: ${activeLabel}`}>
                Org · {activeLabel}
            </span>
        );
    }
    return (
        <span className="org-switcher" ref={wrapRef}>
            <button
                type="button"
                className="chip chip-tool org-chip-trigger"
                aria-haspopup="listbox"
                aria-expanded={open ? 'true' : 'false'}
                onClick={() => setOpen((v) => !v)}
                title={`Active org: ${activeLabel}`}
            >
                Org · {activeLabel} {open ? '▲' : '▼'}
            </button>
            {open && (
                <div className="org-switcher-menu" role="listbox">
                    {orgs.map((o) => (
                        <button
                            key={o.id}
                            type="button"
                            role="option"
                            aria-selected={o.id === user.active_org_id ? 'true' : 'false'}
                            className={`org-switcher-item${o.id === user.active_org_id ? ' active' : ''}`}
                            onClick={() => {
                                setOpen(false);
                                if (o.id !== user.active_org_id) onSwitch(o.id);
                            }}
                        >
                            <span className="org-switcher-name">{o.name}</span>
                            <span className="muted small">{o.slug}</span>
                        </button>
                    ))}
                </div>
            )}
        </span>
    );
}
