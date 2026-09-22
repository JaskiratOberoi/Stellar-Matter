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
    const [vendors, setVendors] = useState([]);
    const [locations, setLocations] = useState([]);
    const [balances, setBalances] = useState([]);
    const [summary, setSummary] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const ready = !authLoading && (!authRequired || Boolean(getToken()));

    const reload = useCallback(async (opts = {}) => {
        if (!ready) return;
        setLoading(true);
        setError(null);
        try {
            const locQs = opts.ensureBus ? '?include_inactive=1&ensure_bus=1' : '?include_inactive=1';
            const [mats, vends, locs, bals, summ] = await Promise.all([
                request('/api/inventory/materials?include_inactive=1'),
                request('/api/inventory/vendors?include_inactive=1'),
                request(`/api/inventory/locations${locQs}`),
                request('/api/inventory/balances'),
                request('/api/inventory/summary')
            ]);
            setMaterials(mats.materials || []);
            setVendors(vends.vendors || []);
            setLocations(locs.locations || []);
            setBalances(bals.balances || []);
            setSummary(summ.summary || null);
        } catch (e) {
            const msg = String(e.message || e);
            if (/failed to fetch|networkerror|load failed/i.test(msg)) {
                setError(
                    'Cannot reach the API (api-matter.stellarinfomatica.com). Check your connection — the backend runs on a home server and may be unreachable off your network.',
                );
            } else {
                setError(msg);
            }
        } finally {
            setLoading(false);
        }
    }, [ready]);

    useEffect(() => {
        reload();
    }, [reload]);

    const syncBusLocations = useCallback(
        async (businessUnits = []) => {
            if (!ready) return;
            try {
                const j = await request('/api/inventory/ensure-bus-locations', {
                    method: 'POST',
                    body: JSON.stringify({
                        business_units: businessUnits.map((o) => ({
                            code: o.id || o.code,
                            name: o.label || o.name
                        }))
                    })
                });
                setLocations(j.locations || []);
            } catch (e) {
                // Best-effort enrichment: dispatch still works off the locations
                // already loaded, so this must not raise a page-level error.
                console.warn('[inventory] BU location sync failed:', e.message || e);
            }
        },
        [ready]
    );

    // -- Mutations (each returns the created/updated row) -------------------

    const createMaterial = useCallback(
        (body) => request('/api/inventory/materials', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const updateMaterial = useCallback(
        (id, body) => request(`/api/inventory/materials/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        []
    );
    const createVendor = useCallback(
        (body) => request('/api/inventory/vendors', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const updateVendor = useCallback(
        (id, body) => request(`/api/inventory/vendors/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
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
    const createMovementsBatch = useCallback(
        (body) => request('/api/inventory/movements/batch', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    // Uploads a single image and returns its URL path (for a line's photo_path).
    // Uses FormData so apiFetch skips the JSON content-type and the browser sets
    // the multipart boundary itself.
    const uploadPhoto = useCallback(async (file) => {
        const form = new FormData();
        form.append('photo', file);
        const j = await request('/api/inventory/photos', { method: 'POST', body: form });
        return j.url;
    }, []);
    // Purchase orders: listed on demand by the Orders view rather than on
    // every reload, since only that view reads them.
    const fetchOrders = useCallback((params = {}) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v != null && v !== '') q.set(k, String(v));
        }
        const qs = q.toString();
        return request(`/api/inventory/orders${qs ? `?${qs}` : ''}`);
    }, []);
    const createOrder = useCallback(
        (body) => request('/api/inventory/orders', { method: 'POST', body: JSON.stringify(body) }),
        []
    );
    const updateOrder = useCallback(
        (id, body) => request(`/api/inventory/orders/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
        []
    );
    // Uploads one PDF (a proforma invoice) and returns { url, name }.
    const uploadDocument = useCallback(async (file) => {
        const form = new FormData();
        form.append('document', file);
        return request('/api/inventory/documents', { method: 'POST', body: form });
    }, []);
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

    // Everyone who has recorded a movement, for the ledger's "recorded by"
    // filter. Fetched by that view on demand rather than on every reload.
    const fetchMovementUsers = useCallback(async () => {
        const j = await request('/api/inventory/movement-users');
        return j.users || [];
    }, []);

    // Super admin only (the API returns 403 otherwise): dispatches into each
    // BU / lab per material per month, for the consumption dashboard.
    const fetchConsumption = useCallback((params = {}) => {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) {
            if (v != null && v !== '') q.set(k, String(v));
        }
        const qs = q.toString();
        return request(`/api/inventory/consumption${qs ? `?${qs}` : ''}`);
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
        vendors,
        locations,
        balances,
        summary,
        loading,
        error,
        ready,
        reload,
        createMaterial,
        updateMaterial,
        createVendor,
        updateVendor,
        createLocation,
        updateLocation,
        createMovement,
        createMovementsBatch,
        uploadPhoto,
        fetchOrders,
        createOrder,
        updateOrder,
        uploadDocument,
        voidMovement,
        seedDefaults,
        syncBusLocations,
        fetchMovements,
        fetchMovementUsers,
        fetchConsumption,
        fetchOnHand,
        fetchLabs
    };
}
