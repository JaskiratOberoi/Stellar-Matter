import { useEffect, useRef, useState } from 'react';
import { isNetworkDown, NETWORK_EVENT } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';

/**
 * App-wide connection and session state, mounted once over every signed-in
 * screen:
 *
 * - Offline: an amber bar under the topbar while the API is unreachable. The
 *   page keeps whatever it last loaded; saves fail until the bar clears.
 * - Session expired: a sign-in sheet over the current screen. Nothing under
 *   it unmounts, so a half-filled form survives re-authentication.
 */
export function SessionGuard() {
    const { user, sessionExpired } = useAuth();
    const [offlineSince, setOfflineSince] = useState(() =>
        isNetworkDown() || (typeof navigator !== 'undefined' && navigator.onLine === false) ? new Date() : null
    );

    useEffect(() => {
        const onNetwork = (e) => setOfflineSince(e.detail && e.detail.offline ? (prev) => prev || new Date() : null);
        const onOffline = () => setOfflineSince((prev) => prev || new Date());
        // The browser saying it's back online is a hint, not proof; the next
        // successful request clears the bar via NETWORK_EVENT.
        window.addEventListener(NETWORK_EVENT, onNetwork);
        window.addEventListener('offline', onOffline);
        return () => {
            window.removeEventListener(NETWORK_EVENT, onNetwork);
            window.removeEventListener('offline', onOffline);
        };
    }, []);

    if (!user) return null;

    return (
        <>
            {offlineSince && !sessionExpired && (
                <div className="session-offline" role="status">
                    <span className="session-offline-dot" aria-hidden="true" />
                    <span>
                        Offline since{' '}
                        {offlineSince.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · showing what
                        was last loaded. Changes won’t save until the connection is back.
                    </span>
                </div>
            )}
            {sessionExpired && <ExpiredSheet />}
        </>
    );
}

function ExpiredSheet() {
    const { user, login, logout } = useAuth();
    const previousUsername = (user && user.username) || '';
    const [username, setUsername] = useState(previousUsername);
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const passwordRef = useRef(null);

    useEffect(() => {
        if (passwordRef.current) passwordRef.current.focus();
    }, []);

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        const r = await login(username.trim(), password);
        setBusy(false);
        if (!r.ok) {
            setErr(r.error);
            return;
        }
        // A different account must not inherit this screen's state.
        if (username.trim().toLowerCase() !== previousUsername.toLowerCase()) window.location.reload();
    }

    return (
        <div className="session-sheet-backdrop">
            <div className="nexus-card login-card session-sheet" role="dialog" aria-modal="true" aria-labelledby="session-sheet-title">
                <h2 id="session-sheet-title" className="session-sheet-title">Session expired</h2>
                <p className="muted small">
                    Sign in again to carry on. This screen stays as it is, but the last thing you saved may not have gone
                    through, so check it after signing in.
                </p>
                <form onSubmit={onSubmit} className="login-form">
                    <label>
                        Username
                        <input
                            type="text"
                            autoComplete="username"
                            value={username}
                            onChange={(e) => setUsername(e.target.value)}
                            required
                        />
                    </label>
                    <label>
                        Password
                        <input
                            ref={passwordRef}
                            type="password"
                            autoComplete="current-password"
                            value={password}
                            onChange={(e) => setPassword(e.target.value)}
                            required
                        />
                    </label>
                    {err && <p className="login-err" role="alert">{err}</p>}
                    <button type="submit" className="btn-primary" disabled={busy || !username || !password}>
                        {busy ? 'Signing in…' : 'Sign in'}
                    </button>
                    <button type="button" className="chip chip-tool session-sheet-out" onClick={logout}>
                        Sign out instead
                    </button>
                </form>
            </div>
        </div>
    );
}
