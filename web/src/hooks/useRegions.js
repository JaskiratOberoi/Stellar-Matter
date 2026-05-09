import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../apiClient.js';

/**
 * @typedef {{ key: string, label: string, mccCount: number }} RegionCityNode
 * @typedef {{ key: string, label: string, mccCount: number, cities: RegionCityNode[] }} RegionStateNode
 */

/**
 * Fetch State → City hierarchy from Listec (via lis-nav-bot `/api/regions`).
 * @returns {{ states: RegionStateNode[], error: string | null, loading: boolean, reload: () => void }}
 */
export function useRegions() {
    const [states, setStates] = useState(/** @type {RegionStateNode[]} */ ([]));
    const [error, setError] = useState(/** @type {string | null} */ (null));
    const [loading, setLoading] = useState(true);

    const load = useCallback(() => {
        setLoading(true);
        apiFetch('/api/regions')
            .then((r) => r.json())
            .then((j) => {
                const list = Array.isArray(j.states) ? j.states : [];
                setStates(list);
                setError(j.error ? String(j.error) : null);
            })
            .catch((e) => {
                setStates([]);
                setError(String(e));
            })
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    return { states, error, loading, reload: load };
}
