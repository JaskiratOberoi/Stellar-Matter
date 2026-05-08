import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

/**
 * Lifted from Stellar-Shark/web/src/components/RoleGate.jsx.
 * Difference: no LoadingMark dependency — renders an inline editorial spinner.
 */
export function RoleGate({ roles, children }) {
    const { user, authRequired, loading } = useAuth();

    if (loading) {
        return <div className="role-gate-loading muted small">Checking access…</div>;
    }

    // Auth not yet wired on the server (404 from /api/auth/me) — let everything through.
    if (!authRequired) return children;

    if (!user || !roles.includes(user.role)) {
        return <Navigate to="/" replace />;
    }

    return children;
}
