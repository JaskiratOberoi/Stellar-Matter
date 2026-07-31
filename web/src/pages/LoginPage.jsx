import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext.jsx';
import { BrandMark } from '../components/BrandMark.jsx';

export function LoginPage() {
    const { user, authRequired, loading, login } = useAuth();
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
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
                <div className="login-brand">
                    <BrandMark size={40} className="login-brand-mark" />
                    <p className="eyebrow">Stellar Matter</p>
                </div>
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
                        <span className="login-password-wrap">
                            <input
                                type={showPassword ? 'text' : 'password'}
                                autoComplete="current-password"
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                            />
                            <button
                                type="button"
                                className="login-password-toggle"
                                onClick={() => setShowPassword((v) => !v)}
                                aria-label={showPassword ? 'Hide password' : 'Show password'}
                                aria-pressed={showPassword ? 'true' : 'false'}
                            >
                                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
                            </button>
                        </span>
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

function EyeIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="12" r="3" />
        </svg>
    );
}

function EyeOffIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c6.5 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M6.71 6.71A18.5 18.5 0 0 0 2 12s3.5 7 10 7a10.94 10.94 0 0 0 5.06-1.26" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M2 2l20 20" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
    );
}
