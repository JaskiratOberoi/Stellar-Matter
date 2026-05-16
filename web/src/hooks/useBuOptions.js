import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { LS_BU_SELECTION, readJSON, writeJSON } from '../lib/storage.js';

export function useBuOptions() {
    const { loading: authLoading, authRequired, user } = useAuth();
    const [options, setOptions] = useState(/** @type {{id:string,label:string}[]} */ ([]));
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(() => new Set(readJSON(LS_BU_SELECTION, []).map(String)));

    const persist = useCallback((next) => {
        writeJSON(LS_BU_SELECTION, [...next]);
    }, []);

    const toggle = useCallback(
        (label) => {
            setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(label)) next.delete(label);
                else next.add(label);
                persist(next);
                return next;
            });
        },
        [persist]
    );

    const selectAll = useCallback(() => {
        setSelected((prev) => {
            const next = new Set(prev);
            for (const o of options) next.add(o.label);
            persist(next);
            return next;
        });
    }, [options, persist]);

    const clear = useCallback(() => {
        setSelected(() => {
            persist(new Set());
            return new Set();
        });
    }, [persist]);

    useEffect(() => {
        if (authLoading) return;
        // When Postgres auth is enabled, wait until we have a JWT so we do not
        // spam 401s and strand the form after login (effect must re-run then).
        if (authRequired && !getToken()) {
            setOptions([]);
            setError(null);
            return;
        }

        let cancelled = false;
        apiFetch('/api/bu')
            .then(async (r) => {
                const text = await r.text();
                let j;
                try {
                    j = JSON.parse(text);
                } catch {
                    const hint = text.trim().startsWith('<')
                        ? 'Received HTML instead of JSON — check that /api is proxied to Matter (same origin).'
                        : 'Invalid JSON from /api/bu.';
                    throw new Error(hint);
                }
                if (!r.ok) {
                    const msg = j && j.error != null ? String(j.error) : `HTTP ${r.status}`;
                    throw new Error(msg);
                }
                return j;
            })
            .then((j) => {
                if (cancelled) return;
                const list = Array.isArray(j.businessUnits) ? j.businessUnits : [];
                const opts = list
                    .map((row) => {
                        if (typeof row === 'string') return { id: row, label: row };
                        const label = String(row.name || row.label || row.id || '').trim();
                        const id = row.id != null ? String(row.id) : label;
                        return label ? { id, label } : null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.label.localeCompare(b.label));
                setOptions(opts);
                setError(j.error ? String(j.error) : null);
                // Drop selections that no longer exist on the server.
                setSelected((prev) => {
                    const known = new Set(opts.map((o) => o.label));
                    let changed = false;
                    const next = new Set();
                    for (const v of prev) {
                        if (known.has(v)) next.add(v);
                        else changed = true;
                    }
                    if (changed) persist(next);
                    return changed ? next : prev;
                });
            })
            .catch((e) => {
                if (cancelled) return;
                setOptions([]);
                setError(String(e));
            });
        return () => {
            cancelled = true;
        };
    }, [persist, authLoading, authRequired, user]);

    return { options, error, selected, toggle, selectAll, clear };
}
