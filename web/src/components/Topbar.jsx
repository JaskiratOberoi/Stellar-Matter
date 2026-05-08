import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export function Topbar({
    currentTab,
    onTabChange,
    statusPill,
    lastUpdated,
    sidebarCollapsed,
    onToggleSidebar
}) {
    const { user, authRequired, logout } = useAuth();
    const tabs = [
        { id: 'letterheads', label: 'Letter Heads' },
        { id: 'envelopes', label: 'Envelopes' },
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
                        <span>Official counter for materials in Genomics</span>
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
                        {user.role === 'super_admin' && (
                            <>
                                <Link to="/admin/users" className="chip chip-tool admin-nav-link">
                                    Users
                                </Link>
                                <Link to="/admin/audit-log" className="chip chip-tool admin-nav-link">
                                    Audit log
                                </Link>
                            </>
                        )}
                        <span>
                            {user.display_name || user.username}
                            {user.role === 'super_admin' && ' \u00b7 admin'}
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
