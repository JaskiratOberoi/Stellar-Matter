import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { apiFetch, setToken, getToken } from '../apiClient.js';

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
            } else {
                setUser(null);
                setOrgs([]);
            }
        } catch {
            setUser(null);
            setOrgs([]);
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
        setOrgs(Array.isArray(body.orgs) ? body.orgs : []);
        setAuthRequired(true);
        return { ok: true };
    }, []);

    const logout = useCallback(() => {
        setToken(null);
        setUser(null);
        setOrgs([]);
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
        () => ({ user, orgs, loading, authRequired, login, logout, refresh, switchOrg, hasToken: !!getToken() }),
        [user, orgs, loading, authRequired, login, logout, refresh, switchOrg]
    );

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    return useContext(AuthContext);
}
