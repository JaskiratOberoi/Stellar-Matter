import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { BrandMark } from './BrandMark.jsx';
import { usePwaInstall } from '../hooks/usePwaInstall.js';
import { CommandPalette } from './CommandPalette.jsx';

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');

const ROLE_LABEL = { super_admin: 'Super admin', admin: 'Admin', operator: 'Operator', viewer: 'Viewer' };

// Admin destinations, each gated by role. The topbar shows them in one menu
// instead of a row of chips.
const ADMIN_LINKS = [
    { to: '/admin/material-requests', label: 'Material requests', caption: 'Review and approve requests', roles: ['super_admin', 'admin'] },
    { to: '/admin/delivery-sites', label: 'Delivery sites', caption: 'Addresses and contacts for challans', roles: ['super_admin', 'admin'] },
    { to: '/admin/users', label: 'Users', caption: 'Accounts and roles', roles: ['super_admin'] },
    { to: '/admin/orgs', label: 'Orgs', caption: 'Organisations and members', roles: ['super_admin'] },
    { to: '/admin/audit-log', label: 'Audit trail', caption: 'Who changed what, when', roles: ['super_admin'] }
];

function initialsOf(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Close a popover on outside pointer or Escape. */
function useDismiss(ref, open, setOpen) {
    useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (e) => {
            if (ref.current && !ref.current.contains(e.target)) setOpen(false);
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
    }, [open, ref, setOpen]);
}

function Caret({ open }) {
    return (
        <svg className={`topbar-caret${open ? ' is-open' : ''}`} width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}

function AdminMenu({ role }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const location = useLocation();
    useDismiss(ref, open, setOpen);
    useEffect(() => setOpen(false), [location.pathname]);
    const links = ADMIN_LINKS.filter((l) => l.roles.includes(role));
    if (!links.length) return null;
    const here = location.pathname.startsWith('/admin');
    return (
        <span className="topbar-menu" ref={ref}>
            <button
                type="button"
                className={`topbar-menu-trigger${here ? ' is-here' : ''}`}
                aria-haspopup="menu"
                aria-expanded={open ? 'true' : 'false'}
                onClick={() => setOpen((v) => !v)}
            >
                Admin
                <Caret open={open} />
            </button>
            {open && (
                <div className="topbar-popover" role="menu">
                    {links.map((l) => (
                        <Link
                            key={l.to}
                            to={l.to}
                            role="menuitem"
                            className={`topbar-popover-item${location.pathname === l.to ? ' is-current' : ''}`}
                            aria-current={location.pathname === l.to ? 'page' : undefined}
                        >
                            <span className="topbar-popover-label">{l.label}</span>
                            <span className="topbar-popover-cap">{l.caption}</span>
                        </Link>
                    ))}
                </div>
            )}
        </span>
    );
}

function AccountMenu({ user, onLogout }) {
    const [open, setOpen] = useState(false);
    const ref = useRef(null);
    const { installMode, triggerNativeInstall } = usePwaInstall();
    useDismiss(ref, open, setOpen);
    const name = user.display_name || user.username;
    return (
        <span className="topbar-menu" ref={ref}>
            <button
                type="button"
                className="topbar-account-trigger"
                aria-haspopup="menu"
                aria-expanded={open ? 'true' : 'false'}
                aria-label={`Account: ${name}`}
                onClick={() => setOpen((v) => !v)}
            >
                <span className="topbar-avatar" aria-hidden="true">{initialsOf(name)}</span>
                <span className="topbar-account-name">{name}</span>
                <Caret open={open} />
            </button>
            {open && (
                <div className="topbar-popover topbar-popover--account" role="menu">
                    <div className="topbar-popover-head">
                        <span className="topbar-popover-label">{name}</span>
                        <span className="topbar-popover-cap">
                            {user.username} · {ROLE_LABEL[user.role] || user.role}
                        </span>
                    </div>
                    {installMode === 'native' && (
                        <button
                            type="button"
                            role="menuitem"
                            className="topbar-popover-item"
                            onClick={async () => {
                                setOpen(false);
                                await triggerNativeInstall();
                            }}
                        >
                            <span className="topbar-popover-label">Install app</span>
                            <span className="topbar-popover-cap">Open Stellar Matter from your dock or home screen</span>
                        </button>
                    )}
                    <button
                        type="button"
                        role="menuitem"
                        className="topbar-popover-item is-danger"
                        onClick={() => {
                            setOpen(false);
                            onLogout();
                        }}
                    >
                        <span className="topbar-popover-label">Log out</span>
                    </button>
                </div>
            )}
        </span>
    );
}

export function Topbar({ statusPill, lastUpdated, onOrgSwitched }) {
    const { user, orgs, authRequired, logout, switchOrg } = useAuth();
    const location = useLocation();
    const [menuOpen, setMenuOpen] = useState(false);
    const [installHintOpen, setInstallHintOpen] = useState(false);
    const drawerRef = useRef(null);
    const [searchOpen, setSearchOpen] = useState(false);

    // Ctrl/Cmd+K opens search from anywhere a signed-in page is showing.
    useEffect(() => {
        const onKey = (e) => {
            if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
                e.preventDefault();
                setSearchOpen((o) => !o);
            }
        };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, []);
    const { installMode, triggerNativeInstall } = usePwaInstall();

    useEffect(() => {
        setMenuOpen(false);
        setInstallHintOpen(false);
    }, [location.pathname]);

    useEffect(() => {
        if (!menuOpen) return undefined;
        const onKey = (e) => {
            if (e.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('keydown', onKey);
        const prev = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => {
            document.removeEventListener('keydown', onKey);
            document.body.style.overflow = prev;
        };
    }, [menuOpen]);

    const switchOrgHandler = async (orgId) => {
        const r = await switchOrg(orgId);
        if (r.ok && typeof onOrgSwitched === 'function') onOrgSwitched(orgId);
        else if (!r.ok) window.alert(r.error || 'Org switch failed');
    };

    // Inventory is home; Tracer is the second tool. Both are always one click
    // away, and the current one is marked.
    const navItems = [
        { to: '/', label: 'Inventory', end: true },
        { to: '/tracer', label: 'Tracer' }
    ];
    const navLinks = (onPick) =>
        navItems.map((n) => (
            <NavLink
                key={n.to}
                to={n.to}
                end={n.end}
                onClick={onPick}
                className={({ isActive }) => `topbar-nav-link${isActive ? ' is-active' : ''}`}
            >
                {n.label}
            </NavLink>
        ));

    return (
        <header className={`topbar${menuOpen ? ' topbar--menu-open' : ''}`} role="banner">
            <div className="topbar-bar">
                <div className="topbar-left">
                    <Link to="/" className="topbar-brand" aria-label="Stellar Matter, Inventory home">
                        <BrandMark size={30} className="topbar-brand-mark" />
                        <span className="topbar-brand-text">
                            <span className="wordmark">Stellar Matter</span>
                            <span className="topbar-tagline">Official tally for materials in Genomics</span>
                        </span>
                    </Link>
                    <nav className="topbar-nav topbar-desktop-nav" aria-label="Main">
                        {navLinks()}
                    </nav>
                </div>
                <div className="topbar-right">
                    {(statusPill || lastUpdated) && (
                        <span className="topbar-run">
                            {statusPill && <span className={`status-pill ${statusPill.kind}`}>{statusPill.text}</span>}
                            {lastUpdated && (
                                <span className="last-updated" aria-live="polite">
                                    Updated{' '}
                                    {lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                </span>
                            )}
                        </span>
                    )}
                    {user && (
                        <button
                            type="button"
                            className="topbar-search topbar-desktop-nav"
                            onClick={() => setSearchOpen(true)}
                            aria-label="Search"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                                <circle cx="11" cy="11" r="7" />
                                <path d="m20 20-3.5-3.5" />
                            </svg>
                            <span className="topbar-search-label">Search</span>
                            <kbd>{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
                        </button>
                    )}
                    {authRequired && user && (
                        <span className="topbar-desktop-user">
                            <OrgSwitcher user={user} orgs={orgs} onSwitch={switchOrgHandler} />
                            <AdminMenu role={user.role} />
                            <AccountMenu user={user} onLogout={logout} />
                        </span>
                    )}
                    {authRequired && user && (
                        <button
                            type="button"
                            className="topbar-menu-btn"
                            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                            aria-expanded={menuOpen ? 'true' : 'false'}
                            aria-controls="topbar-drawer"
                            onClick={() => setMenuOpen((v) => !v)}
                        >
                            <span className={`topbar-menu-ico${menuOpen ? ' is-open' : ''}`} aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>

            {menuOpen &&
                createPortal(
                    <div className="topbar-drawer-root">
                        <button
                            type="button"
                            className="topbar-drawer-scrim"
                            aria-label="Close menu"
                            onClick={() => setMenuOpen(false)}
                        />
                        <nav
                            id="topbar-drawer"
                            className="topbar-drawer"
                            ref={drawerRef}
                            aria-label="App menu"
                        >
                            <div className="topbar-drawer-section topbar-drawer-nav">
                                <p className="eyebrow">Navigate</p>
                                {navLinks(() => setMenuOpen(false))}
                                <button
                                    type="button"
                                    className="topbar-nav-link"
                                    onClick={() => {
                                        setMenuOpen(false);
                                        setSearchOpen(true);
                                    }}
                                >
                                    Search materials, sites and pages
                                </button>
                            </div>
                            {installMode !== 'installed' && (
                                <div className="topbar-drawer-section">
                                    <p className="eyebrow">App</p>
                                    {installMode === 'native' ? (
                                        <button
                                            type="button"
                                            className="chip chip-tool topbar-drawer-install"
                                            onClick={async () => {
                                                await triggerNativeInstall();
                                                setMenuOpen(false);
                                            }}
                                        >
                                            Install app
                                        </button>
                                    ) : (
                                        <>
                                            <button
                                                type="button"
                                                className="chip chip-tool topbar-drawer-install"
                                                aria-expanded={installHintOpen ? 'true' : 'false'}
                                                onClick={() => setInstallHintOpen((v) => !v)}
                                            >
                                                Install app
                                            </button>
                                            {installHintOpen && (
                                                <p className="topbar-drawer-hint">
                                                    {installMode === 'ios' ? (
                                                        <>
                                                            Tap <strong>Share</strong> then{' '}
                                                            <strong>Add to Home Screen</strong> to install Inventory on
                                                            your phone.
                                                        </>
                                                    ) : (
                                                        <>
                                                            Open your browser menu and choose{' '}
                                                            <strong>Add to Home Screen</strong> or{' '}
                                                            <strong>Install app</strong>.
                                                        </>
                                                    )}
                                                </p>
                                            )}
                                        </>
                                    )}
                                </div>
                            )}
                            {user && (
                                <>
                                    <div className="topbar-drawer-section">
                                        <p className="eyebrow">Account</p>
                                        <p className="topbar-drawer-user">
                                            {user.display_name || user.username} · {ROLE_LABEL[user.role] || user.role}
                                        </p>
                                        <OrgSwitcher user={user} orgs={orgs} onSwitch={switchOrgHandler} />
                                    </div>
                                    {(user.role === 'super_admin' || user.role === 'admin') && (
                                        <div className="topbar-drawer-section">
                                            <p className="eyebrow">Admin</p>
                                            <Link
                                                to="/admin/material-requests"
                                                className="chip chip-tool"
                                                onClick={() => setMenuOpen(false)}
                                            >
                                                Materials requests
                                            </Link>
                                            <Link
                                                to="/admin/delivery-sites"
                                                className="chip chip-tool"
                                                onClick={() => setMenuOpen(false)}
                                            >
                                                Delivery sites
                                            </Link>
                                            {user.role === 'super_admin' && (
                                                <>
                                                    <Link
                                                        to="/admin/users"
                                                        className="chip chip-tool"
                                                        onClick={() => setMenuOpen(false)}
                                                    >
                                                        Users
                                                    </Link>
                                                    <Link
                                                        to="/admin/orgs"
                                                        className="chip chip-tool"
                                                        onClick={() => setMenuOpen(false)}
                                                    >
                                                        Orgs
                                                    </Link>
                                                    <Link
                                                        to="/admin/audit-log"
                                                        className="chip chip-tool"
                                                        onClick={() => setMenuOpen(false)}
                                                    >
                                                        Audit trail
                                                    </Link>
                                                </>
                                            )}
                                        </div>
                                    )}
                                    <div className="topbar-drawer-section">
                                        <button
                                            type="button"
                                            className="chip chip-tool user-logout"
                                            onClick={() => {
                                                setMenuOpen(false);
                                                logout();
                                            }}
                                        >
                                            Log out
                                        </button>
                                    </div>
                                </>
                            )}
                        </nav>
                    </div>,
                    document.body,
                )}
            {user && <CommandPalette role={user.role} open={searchOpen} onClose={() => setSearchOpen(false)} />}
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
            <span className="topbar-org org-chip-static" title={`Active org: ${activeLabel}`}>
                <span className="topbar-org-label">Org</span>
                <span className="topbar-org-name">{activeLabel}</span>
            </span>
        );
    }
    return (
        <span className="org-switcher" ref={wrapRef}>
            <button
                type="button"
                className="topbar-org org-chip-trigger"
                aria-haspopup="listbox"
                aria-expanded={open ? 'true' : 'false'}
                onClick={() => setOpen((v) => !v)}
                title={`Active org: ${activeLabel}`}
            >
                <span className="topbar-org-label">Org</span>
                <span className="topbar-org-name">{activeLabel}</span>
                <Caret open={open} />
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
