import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';

/**
 * @typedef {{ userId: number, label: string, codeCount: number }} SalesMarketingUser
 */

async function readJsonResponse(r) {
    const text = await r.text();
    let j;
    try {
        j = JSON.parse(text);
    } catch {
        const hint = text.trim().startsWith('<')
            ? 'Received HTML instead of JSON — check that /api is proxied to Matter (same origin).'
            : 'Invalid JSON from sales-marketing endpoint.';
        throw new Error(hint);
    }
    if (!r.ok) {
        const msg = j && j.error != null ? String(j.error) : `HTTP ${r.status}`;
        throw new Error(msg);
    }
    return j;
}

/**
 * Fetch Sales and Marketing users from Listec (via `/api/tracer/sales-marketing-users`).
 */
export function useSalesMarketingUsers() {
    const { loading: authLoading, authRequired, user } = useAuth();
    const [users, setUsers] = useState(/** @type {SalesMarketingUser[]} */ ([]));
    const [error, setError] = useState(/** @type {string | null} */ (null));
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        if (authLoading) return;
        if (authRequired && !getToken()) {
            setUsers([]);
            setError(null);
            setLoading(false);
            return;
        }

        setLoading(true);
        apiFetch('/api/tracer/sales-marketing-users')
            .then((r) => readJsonResponse(r))
            .then((j) => {
                const list = Array.isArray(j.users) ? j.users : [];
                setUsers(list);
                setError(j.error ? String(j.error) : null);
            })
            .catch((e) => {
                setUsers([]);
                setError(String(e));
            })
            .finally(() => setLoading(false));
    }, [authLoading, authRequired, user]);

    useEffect(() => {
        load();
    }, [load]);

    return { users, error, loading, reload: load };
}
