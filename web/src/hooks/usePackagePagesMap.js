import { useEffect, useState } from 'react';
import { apiFetch } from '../apiClient.js';
import { normalizePackageLabel } from '../lib/format.js';

export function usePackagePagesMap() {
    const [map, setMap] = useState({});
    useEffect(() => {
        let cancelled = false;
        apiFetch('/api/package-pages')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((j) => {
                if (cancelled) return;
                const next = {};
                for (const [k, v] of Object.entries((j && j.pages) || {})) {
                    const n = Number(v);
                    if (!Number.isFinite(n)) continue;
                    next[normalizePackageLabel(k)] = n;
                }
                setMap(next);
            })
            .catch(() => {
                if (!cancelled) setMap({});
            });
        return () => {
            cancelled = true;
        };
    }, []);
    return map;
}
