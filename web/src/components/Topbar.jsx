import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export function Topbar({
    currentTab,
    onTabChange,
    statusPill,
    lastUpdated,
    sidebarCollapsed,
    onToggleSidebar,
    onOrgSwitched
}) {
    const { user, orgs, authRequired, logout, switchOrg } = useAuth();
    const tabs = [
        { id: 'letterheads', label: 'Letter Heads' },
        { id: 'envelopes', label: 'Envelopes' },
        { id: 'urine_containers', label: 'Urine Containers' },
        { id: 'history', label: 'History' }
    ];
    return (
        <header className="topbar" role="banner">
            <div className="topbar-left">
                <button
                    type="button"
                    className="sidebar-toggle-btn"
                    aria-expanded={sidebarCollapsed ? 'false' : 'true'}
                    title={sidebarCollapsed ? 'Expand run panel' : 'Collapse run panel'}
                    onClick={onToggleSidebar}
                >
                    <span className="ico-sidebar" aria-hidden="true" />
                </button>
                <div className="topbar-brand">
                    <h1 className="wordmark">Stellar Matter</h1>
                    <p className="muted topbar-tagline">
                        <span>Official tally for materials in Genomics</span>
                    </p>
                </div>
                <nav className="tablist" role="tablist" aria-label="Main sections">
                    {tabs.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={currentTab === t.id ? 'true' : 'false'}
                            className={currentTab === t.id ? 'active' : ''}
                            onClick={() => onTabChange(t.id)}
                        >
                            {t.label}
                        </button>
                    ))}
                </nav>
            </div>
            <div className="topbar-right">
                {statusPill && <span className={`status-pill ${statusPill.kind}`}>{statusPill.text}</span>}
                {lastUpdated && (
                    <span className="last-updated muted small" aria-live="polite">
                        Updated {lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                )}
                {authRequired && user && (
                    <span className="user-chip muted small">
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
                        <span>
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
        </header>
    );
}

function OrgSwitcher({ user, orgs, onSwitch }) {
    const [open, setOpen] = useState(false);
    if (!orgs || orgs.length === 0) return null;
    const active = orgs.find((o) => o.id === user.active_org_id) || null;
    const activeLabel = active ? active.name : '— no org —';
    // For users with exactly one assignment we still show the chip (read-only)
    // so it's obvious which tenant they're acting on. super_admin always gets
    // the dropdown because they may need to switch even with one assignment if
    // more orgs become available later.
    const canSwitch = orgs.length > 1 || user.role === 'super_admin';
    if (!canSwitch) {
        return (
            <span className="chip chip-tool org-chip-static" title={`Active org: ${activeLabel}`}>
                Org · {activeLabel}
            </span>
        );
    }
    return (
        <span className="org-switcher">
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
