import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';

// Thin wrapper over the /api/inventory endpoints. Loads the catalog (materials
// + locations), current balances and headline summary on mount, and exposes
// mutation helpers plus on-demand fetchers for the paginated ledger, live
// on-hand lookups and the client_locations lab picker.
//
// Every helper throws an Error carrying the server's { error } message so the
// page can surface it inline; reads populate hook state and are refreshed via
// reload().

async function readJson(res) {
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        throw new Error(
            text.trim().startsWith('<')
                ? 'Received HTML instead of JSON — is /api proxied to the server?'
                : 'Invalid JSON from server.'
        );
    }
    if (!res.ok) {
        throw new Error(json && json.error ? String(json.error) : `HTTP ${res.status}`);
    }
    return json;
}

async function request(path, init) {
    const res = await apiFetch(path, init);
    return readJson(res);
}

export function useInventory() {
    const { loading: authLoading, authRequired } = useAuth();
    const [materials, setMaterials] = useState([]);
    const [locations, setLocations] = useState([]);
    const [balances, setBalances] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const ready = !authLoading && (!authRequired || Boolean(getToken()));

    const reload = useCallback(async () => {
        if (!ready) return;
        setLoading(true);
        setError(null);
        try {
            const [mats, locs, bals, summ] = await Promise.all([
                request('/api/inventory/materials?include_inactive=1'),
                request('/api/inventory/locations?include_inactive=1'),
                request('/api/inventory/balances'),
                request('/api/inventory/summary')
            ]);
            setMaterials(mats.materials || []);
            setLocations(locs.locations || []);
            setBalances(bals.balances || []);
            setSummary(summ.summary || null);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setLoading(false);
        }
    }, [ready]);

    useEffect(() => {
        reload();
    }, [reload]);

    // -- Mutations (each returns the created/updated row) -------------------

    const createMaterial = useCallback(
        (body) => request('/api/inventory/materials', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const updateMaterial = useCallback(
        (id, body) => request(`/api/inventory/materials/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        []
    );
    const createLocation = useCallback(
        (body) => request('/api/inventory/locations', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const updateLocation = useCallback(
        (id, body) => request(`/api/inventory/locations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        []
    );
    const createMovement = useCallback(
        (body) => request('/api/inventory/movements', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const voidMovement = useCallback(
        (id, body = {}) => request(`/api/inventory/movements/${id}/void`, { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const seedDefaults = useCallback(
        () => request('/api/inventory/seed-defaults', { method: 'POST', body: '{}' }),
        []
    );

    // -- On-demand reads ---------------------------------------------------

    const fetchMovements = useCallback((params = {}) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v != null && v !== '') q.set(k, String(v));
        }
        const qs = q.toString();
        return request(`/api/inventory/movements${qs ? `?${qs}` : ''}`);
    }, []);

    const fetchOnHand = useCallback(async (materialId, locationId) => {
        const q = new URLSearchParams({ material_id: materialId, location_id: locationId });
        const j = await request(`/api/inventory/on-hand?${q.toString()}`);
        return Number(j.on_hand) || 0;
    }, []);

    const fetchLabs = useCallback(async () => {
        const j = await request('/api/inventory/lab-options');
        return j.labs || [];
    }, []);

    return {
        materials,
        locations,
        balances,
        summary,
        loading,
        error,
        ready,
        reload,
        createMaterial,
        updateMaterial,
        createLocation,
        updateLocation,
        createMovement,
        voidMovement,
        seedDefaults,
        fetchMovements,
        fetchOnHand,
        fetchLabs
    };
}
