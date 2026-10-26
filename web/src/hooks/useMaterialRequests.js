import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';

async function readJson(res) {
    const text = await res.text();
    let json;
    try {
        json = text ? JSON.parse(text) : {};
    } catch {
        // An HTML page here means the API answered with its app shell: the
        // server running doesn't have the material-requests routes yet.
        throw new Error(
            text.trim().startsWith('<')
                ? "This server doesn't have material requests yet. The API needs updating."
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

/** Public helpers — no auth token required. */
export async function unlockMaterialRequestCatalog(code) {
    return request('/api/material-requests/public/unlock', {
        method: 'POST',
        body: JSON.stringify({ code })
    });
}

export async function submitMaterialRequest(payload) {
    return request('/api/material-requests/public/submit', {
        method: 'POST',
        body: JSON.stringify(payload)
    });
}

/** Authenticated admin / super_admin queue helpers. */
export function useMaterialRequests({ status = null, autoLoad = true } = {}) {
    const { loading: authLoading, authRequired, user } = useAuth();
    const [requests, setRequests] = useState([]);
    const [batches, setBatches] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const ready = !authLoading && (!authRequired || Boolean(getToken()));
    const canReview = !authRequired || (user && (user.role === 'admin' || user.role === 'super_admin'));

    const reload = useCallback(async () => {
        if (!ready || !canReview) {
            setLoading(false);
            return;
        }
        setLoading(true);
        setError(null);
        try {
            const qs = status ? `?status=${encodeURIComponent(status)}` : '';
            const [reqJ, batJ] = await Promise.all([
                request(`/api/material-requests${qs}`),
                request('/api/material-requests/batches')
            ]);
            setRequests(reqJ.requests || []);
            setBatches(batJ.batches || []);
        } catch (e) {
            setError(String(e.message || e));
        } finally {
            setLoading(false);
        }
    }, [ready, canReview, status]);

    useEffect(() => {
        if (autoLoad) reload();
    }, [autoLoad, reload]);

    const approve = useCallback(
        async (id) => {
            const j = await request(`/api/material-requests/${id}/approve`, { method: 'POST', body: '{}' });
            await reload();
            return j.request;
        },
        [reload]
    );

    const cancelRequest = useCallback(
        async (id, reason) => {
            const j = await request(`/api/material-requests/${id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ reason: reason || null })
            });
            await reload();
            return j.request;
        },
        [reload]
    );

    const getRequest = useCallback(async (id) => {
        const j = await request(`/api/material-requests/${id}`);
        return j.request;
    }, []);

    /** Last month's usage at the request's site, line by line. */
    const getUsage = useCallback(async (id) => {
        const j = await request(`/api/material-requests/${id}/usage`);
        return j.usage;
    }, []);

    /** Over-usage flags for every open request, keyed by request id. */
    const getUsageFlags = useCallback(async () => {
        const j = await request('/api/material-requests/usage-flags');
        return j;
    }, []);

    /** Trim or correct one line; the request comes back with the new quantity. */
    const setLineQuantity = useCallback(async (id, lineId, quantity, reason) => {
        const j = await request(`/api/material-requests/${id}/lines/${lineId}/quantity`, {
            method: 'POST',
            body: JSON.stringify({ quantity, reason: reason || null })
        });
        return j.request;
    }, []);

    const combine = useCallback(
        async (requestIds, note) => {
            const j = await request('/api/material-requests/batches', {
                method: 'POST',
                body: JSON.stringify({ request_ids: requestIds, note: note || null })
            });
            await reload();
            return j.batch;
        },
        [reload]
    );

    const getBatch = useCallback(async (id) => {
        const j = await request(`/api/material-requests/batches/${id}`);
        return j.batch;
    }, []);

    const submitBatch = useCallback(
        async (id) => {
            const j = await request(`/api/material-requests/batches/${id}/submit`, {
                method: 'POST',
                body: '{}'
            });
            await reload();
            return j.batch;
        },
        [reload]
    );

    const sendBatch = useCallback(
        async (id) => {
            const j = await request(`/api/material-requests/batches/${id}/send`, {
                method: 'POST',
                body: '{}'
            });
            await reload();
            return j.batch;
        },
        [reload]
    );

    const cancelBatch = useCallback(
        async (id, reason) => {
            const j = await request(`/api/material-requests/batches/${id}/cancel`, {
                method: 'POST',
                body: JSON.stringify({ reason: reason || null })
            });
            await reload();
            return j.batch;
        },
        [reload]
    );

    return {
        requests,
        batches,
        loading,
        error,
        canReview,
        reload,
        approve,
        cancelRequest,
        getRequest,
        getUsage,
        getUsageFlags,
        setLineQuantity,
        combine,
        getBatch,
        submitBatch,
        sendBatch,
        cancelBatch
    };
}
