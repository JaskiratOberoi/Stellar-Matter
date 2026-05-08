import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, setToken, getToken } from '../apiClient.js';

const AuthContext = createContext({
    user: null,
    loading: true,
    authRequired: true,
    login: async () => ({ ok: false, error: 'not initialised' }),
    logout: () => {},
    refresh: async () => {}
});

export function AuthProvider({ children }) {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);
    // If the server returns 404 for /api/auth/me (auth not yet wired) we treat the app as open.
    const [authRequired, setAuthRequired] = useState(true);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            const r = await apiFetch('/api/auth/me');
            if (r.status === 404) {
                setAuthRequired(false);
                setUser(null);
                return;
            }
            setAuthRequired(true);
            if (r.ok) {
                const j = await r.json();
                setUser(j.user || null);
            } else {
                setUser(null);
            }
        } catch {
            setUser(null);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const login = useCallback(async (username, password) => {
        const r = await apiFetch('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ username, password })
        });
        let body = null;
        try {
            body = await r.json();
        } catch {
            body = null;
        }
        if (!r.ok || !body || !body.token) {
            return { ok: false, error: (body && body.error) || `Login failed (${r.status})` };
        }
        setToken(body.token);
        setUser(body.user || null);
        setAuthRequired(true);
        return { ok: true };
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        setUser(null);
    }, []);

    const value = useMemo(
        () => ({ user, loading, authRequired, login, logout, refresh, hasToken: !!getToken() }),
        [user, loading, authRequired, login, logout, refresh]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    return useContext(AuthContext);
}
