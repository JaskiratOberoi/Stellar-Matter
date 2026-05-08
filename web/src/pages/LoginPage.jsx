import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';

export function LoginPage() {
    const { user, authRequired, loading, login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    if (loading) return <div className="role-gate-loading muted small">Checking access…</div>;
    if (!authRequired || user) return <Navigate to="/" replace />;

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await login(username.trim(), password);
        setBusy(false);
        if (!r.ok) setErr(r.error || 'Login failed');
    }

    return (
        <main className="login-shell">
            <div className="nexus-card login-card">
                <p className="eyebrow">Stellar Matter</p>
                <h1 className="wordmark login-title">Sign in</h1>
                <p className="muted small login-sub">Use the credentials seeded by your administrator.</p>
                <form onSubmit={onSubmit} className="login-form">
                    <label>
                        Username
                        <input
                            type="text"
                            autoComplete="username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                            autoFocus
                        />
                    </label>
                    <label>
                        Password
                        <input
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    {err && <p className="login-err">{err}</p>}
                    <button type="submit" className="btn-primary" disabled={busy || !username || !password}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                </form>
            </div>
        </main>
    );
}
