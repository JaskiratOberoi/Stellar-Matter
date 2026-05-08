import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '../apiClient.js';

export function useTiles() {
    const [tiles, setTiles] = useState([]);
    const [errors, setErrors] = useState([]);
    const [loadError, setLoadError] = useState(null);
    const [loadedAt, setLoadedAt] = useState(null);

    const load = useCallback(async () => {
        try {
            const r = await apiFetch('/api/runs/tiles');
            const j = await r.json();
            setTiles(Array.isArray(j.tiles) ? j.tiles : []);
            setErrors(Array.isArray(j.errors) ? j.errors : []);
            setLoadError(null);
            setLoadedAt(new Date());
        } catch (e) {
            setLoadError(String(e));
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    return { tiles, errors, loadError, loadedAt, reload: load };
}
