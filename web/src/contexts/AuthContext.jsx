import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, apiUrl, setToken, getToken, SESSION_EXPIRED_EVENT } from '../apiClient.js';

// Last signed-in user, so an installed PWA opened with no signal can still
// show the app (read-only, marked offline) instead of a login it can't use.
const USER_CACHE_KEY = 'stellar_matter_user';

function readCachedUser() {
    try {
        return JSON.parse(localStorage.getItem(USER_CACHE_KEY) || 'null');
    } catch {
        return null;
    }
}

function writeCachedUser(user, orgs) {
    try {
        if (user) localStorage.setItem(USER_CACHE_KEY, JSON.stringify({ user, orgs }));
        else localStorage.removeItem(USER_CACHE_KEY);
    } catch {
        /* storage blocked */
    }
}

/** Plain-language message for a failed sign-in. */
function loginErrorMessage(status, serverError) {
    if (status === 429) return 'Too many sign-in attempts. Wait a minute, then try again.';
    if (status >= 500) return 'The server had a problem signing you in. Try again in a moment.';
    return serverError || 'Sign-in failed. Check your username and password.';
}

const AuthContext = createContext({
    user: null,
    orgs: [],
    loading: true,
    authRequired: true,
    login: async () => ({ ok: false, error: 'not initialised' }),
    logout: () => {},
    refresh: async () => {},
    switchOrg: async () => ({ ok: false, error: 'not initialised' })
});

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [orgs, setOrgs] = useState([]);
    const [loading, setLoading] = useState(true);
    // If the server returns 404 for /api/auth/me (auth not yet wired) we treat the app as open.
    const [authRequired, setAuthRequired] = useState(true);
    // The token was rejected mid-session. The user stays "signed in" so the
    // current screen (and any half-filled form) stays mounted under a sign-in
    // sheet instead of being thrown back to /login.
    const [sessionExpired, setSessionExpired] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const r = await apiFetch('/api/auth/me');
            if (r.status === 404) {
                setAuthRequired(false);
                setUser(null);
                setOrgs([]);
                return;
            }
            setAuthRequired(true);
            if (r.ok) {
                const j = await r.json();
                setUser(j.user || null);
                setOrgs(Array.isArray(j.orgs) ? j.orgs : []);
                writeCachedUser(j.user || null, j.orgs || []);
                setSessionExpired(false);
            } else if (r.status >= 500 && getToken()) {
                // Server trouble is not a sign-out: keep the cached user.
                const cached = readCachedUser();
                setUser(cached ? cached.user : null);
                setOrgs(cached && Array.isArray(cached.orgs) ? cached.orgs : []);
            } else {
                setUser(null);
                setOrgs([]);
                writeCachedUser(null);
            }
        } catch {
            // Unreachable (offline, server down): keep the cached user if a
            // token is still held; the shell shows an offline bar.
            const cached = getToken() ? readCachedUser() : null;
            setUser(cached ? cached.user : null);
            setOrgs(cached && Array.isArray(cached.orgs) ? cached.orgs : []);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    useEffect(() => {
        const onExpired = () => setSessionExpired(true);
        window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
        return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
    }, []);

    const login = useCallback(async (username, password) => {
        // Do not send a stale Bearer token — `apiFetch` always attaches one if present,
        // which can confuse proxies / rate-limit IP logic on shared dev setups.
        let r;
        try {
            r = await fetch(apiUrl('/api/auth/login'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
        } catch {
            return { ok: false, error: "Can't reach the server. Check your connection and try again." };
        }
        let body = null;
        try {
            body = await r.json();
        } catch {
            body = null;
        }
        if (!r.ok || !body || !body.token) {
            return { ok: false, error: loginErrorMessage(r.status, body && body.error) };
        }
        setToken(body.token);
        setUser(body.user || null);
        setOrgs(Array.isArray(body.orgs) ? body.orgs : []);
        writeCachedUser(body.user || null, body.orgs || []);
        setAuthRequired(true);
        setSessionExpired(false);
        return { ok: true };
    }, []);

    const logout = useCallback(() => {
        // Tell the server first so the audit trail records the sign-out, but
        // never let a failed/offline call keep the user signed in.
        apiFetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
        setToken(null);
        setUser(null);
        setOrgs([]);
        writeCachedUser(null);
        setSessionExpired(false);
    }, []);

    const switchOrg = useCallback(async (orgId) => {
        const r = await apiFetch('/api/auth/switch-org', {
            method: 'POST',
            body: JSON.stringify({ org_id: orgId })
        });
        let body = null;
        try {
            body = await r.json();
        } catch {
            body = null;
        }
        if (!r.ok || !body || !body.token) {
            return { ok: false, error: (body && body.error) || `Switch failed (${r.status})` };
        }
        setToken(body.token);
        setUser(body.user || null);
        setOrgs(Array.isArray(body.orgs) ? body.orgs : []);
        return { ok: true };
    }, []);

    const value = useMemo(
        () => ({ user, orgs, loading, authRequired, sessionExpired, login, logout, refresh, switchOrg, hasToken: !!getToken() }),
        [user, orgs, loading, authRequired, sessionExpired, login, logout, refresh, switchOrg]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    return useContext(AuthContext);
}
