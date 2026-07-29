import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export const TABS = [
    { id: 'letterheads', label: 'Letter Heads' },
    { id: 'envelopes', label: 'Envelopes' },
    { id: 'urine_containers', label: 'Urine Containers' },
    { id: 'edta_vials', label: 'EDTA Vials' },
    { id: 'flouride_vials', label: 'Flouride Vials' },
    { id: 'citrate_vials', label: 'Citrate' },
    { id: 's_heparin', label: 'S.Heparin' },
    { id: 'l_heparin', label: 'L.Heparin' },
    { id: 'lbc', label: 'LBC' },
    { id: 'barcode', label: 'Barcode' },
    { id: 'serum', label: 'Serum' },
    { id: 'history', label: 'History' }
];

export const TAB_IDS = TABS.map((t) => t.id);
/* Every tab except History renders the same tile wall, keyed by kind. */
export const METRIC_TAB_IDS = TAB_IDS.filter((id) => id !== 'history');

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
    const location = useLocation();
    // Tracer is now the default surface at `/`; the legacy tabbed dashboard
    // lives at `/dashboard`. Treat the legacy `/tracer` alias as tracer too
    // so the toggle still works if a bookmark hits the old URL before the
    // redirect fires.
    const isTracer = location.pathname === '/' || location.pathname === '/tracer';

    return (
        <header className="topbar" role="banner">
            <div className="topbar-bar">
                <div className="topbar-left">
                    {!isTracer && (
                        <button
                            type="button"
                            className="sidebar-toggle-btn"
                            aria-expanded={sidebarCollapsed ? 'false' : 'true'}
                            title={sidebarCollapsed ? 'Expand run panel' : 'Collapse run panel'}
                            onClick={onToggleSidebar}
                        >
                            <span className="ico-sidebar" aria-hidden="true" />
                        </button>
                    )}
                    <div className="topbar-brand">
                        <div className="topbar-brand-text">
                            <h1 className="wordmark">Stellar Matter</h1>
                            <p className="topbar-tagline">Official tally for materials in Genomics</p>
                        </div>
                        <Link
                            to={isTracer ? '/dashboard' : '/'}
                            className="chip chip-tool tracer-ui-link"
                            title={isTracer ? 'Open tabbed dashboard' : 'Return to Tracer'}
                        >
                            {isTracer ? 'Switch to Dashboard' : 'Switch to Tracer'}
                        </Link>
                        <Link
                            to="/inventory"
                            className="chip chip-tool tracer-ui-link"
                            title="Open the inventory tracker"
                        >
                            Inventory
                        </Link>
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
            {!isTracer && <TabStrip currentTab={currentTab} onTabChange={onTabChange} />}
        </header>
    );
}

function TabStrip({ currentTab, onTabChange }) {
    const listRef = useRef(null);
    const [overflow, setOverflow] = useState('none');

    // Which edges are still scrollable, so the fade only appears on a side
    // that actually has more tabs behind it.
    const syncOverflow = useCallback(() => {
        const el = listRef.current;
        if (!el) return;
        const maxScroll = el.scrollWidth - el.clientWidth;
        if (maxScroll <= 1) {
            setOverflow('none');
            return;
        }
        const atStart = el.scrollLeft <= 1;
        const atEnd = el.scrollLeft >= maxScroll - 1;
        setOverflow(atStart ? 'end' : atEnd ? 'start' : 'both');
    }, []);

    useLayoutEffect(() => {
        syncOverflow();
        const el = listRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return undefined;
        const ro = new ResizeObserver(syncOverflow);
        ro.observe(el);
        return () => ro.disconnect();
    }, [syncOverflow]);

    // Keep the selected tab visible when the tab changes from elsewhere (e.g.
    // restored from localStorage on load).
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const active = el.querySelector('[aria-selected="true"]');
        if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, [currentTab]);

    // Arrow-key navigation, as expected of a tablist. Combined with the roving
    // tabindex below, Tab moves past the whole strip in one press.
    const onKeyDown = (e) => {
        const i = TABS.findIndex((t) => t.id === currentTab);
        let next = -1;
        if (e.key === 'ArrowRight') next = (i + 1) % TABS.length;
        else if (e.key === 'ArrowLeft') next = (i - 1 + TABS.length) % TABS.length;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = TABS.length - 1;
        if (next < 0) return;
        e.preventDefault();
        onTabChange(TABS[next].id);
        const el = listRef.current;
        if (el) {
            const btn = el.querySelectorAll('[role="tab"]')[next];
            if (btn) btn.focus();
        }
    };

    return (
        <div className="tabbar" data-overflow={overflow}>
            <nav
                className="tablist"
                role="tablist"
                aria-label="Main sections"
                ref={listRef}
                onScroll={syncOverflow}
                onKeyDown={onKeyDown}
            >
                {TABS.map((t) => {
                    const selected = currentTab === t.id;
                    return (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            id={`tab-${t.id}`}
                            // Only the selected panel is mounted, so pointing at
                            // it from an inactive tab would be a dangling IDREF.
                            aria-controls={selected ? `tabpanel-${t.id}` : undefined}
                            aria-selected={selected ? 'true' : 'false'}
                            tabIndex={selected ? 0 : -1}
                            className={selected ? 'active' : ''}
                            onClick={() => onTabChange(t.id)}
                        >
                            {t.label}
                        </button>
                    );
                })}
            </nav>
        </div>
    );
}

function OrgSwitcher({ user, orgs, onSwitch }) {
    const [open, setOpen] = useState(false);
    const wrapRef = useRef(null);

    // Native buttons give us no dismissal behaviour, so wire up the two the
    // menu pattern expects: click-away and Escape.
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
