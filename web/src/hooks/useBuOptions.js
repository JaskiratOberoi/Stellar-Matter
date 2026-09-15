import { useCallback, useEffect, useState } from 'react';
import { apiFetch, getToken } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { LS_BU_SELECTION, LS_BU_GROUP_SELECTION, readJSON, writeJSON } from '../lib/storage.js';

export function useBuOptions() {
    const { loading: authLoading, authRequired, user } = useAuth();
    const [options, setOptions] = useState(/** @type {{id:string,label:string,title?:string}[]} */ ([]));
    const [error, setError] = useState(null);
    const [selected, setSelected] = useState(() => new Set(readJSON(LS_BU_SELECTION, []).map(String)));
    // Temporary sub-BU groups (server data/business-unit-groups.json) — keyed
    // by id, kept apart from the BU label set so "All" never double-counts a
    // parent and its group.
    const [groups, setGroups] = useState(
        /** @type {{ id: string, label: string, name: string|null, parent: string|null, codeCount: number }[]} */ ([])
    );
    const [groupSelected, setGroupSelected] = useState(() => new Set(readJSON(LS_BU_GROUP_SELECTION, []).map(String)));

    const persist = useCallback((next) => {
        writeJSON(LS_BU_SELECTION, [...next]);
    }, []);
    const persistGroups = useCallback((next) => {
        writeJSON(LS_BU_GROUP_SELECTION, [...next]);
    }, []);

    const toggleGroup = useCallback(
        (id) => {
            setGroupSelected((prev) => {
                const next = new Set(prev);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                persistGroups(next);
                return next;
            });
        },
        [persistGroups]
    );

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

    // BU "Clear" only touches BU chips; the Regions section has its own pair.
    const clear = useCallback(() => {
        setSelected(() => {
            persist(new Set());
            return new Set();
        });
    }, [persist]);
    const selectAllGroups = useCallback(() => {
        setGroupSelected(() => {
            const next = new Set(groups.map((g) => g.id));
            persistGroups(next);
            return next;
        });
    }, [groups, persistGroups]);
    const clearGroups = useCallback(() => {
        setGroupSelected(() => {
            persistGroups(new Set());
            return new Set();
        });
    }, [persistGroups]);

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
                        // The server sends one row per unit: `label` is the chip
                        // text (the short code), `name` the full spelling for the
                        // tooltip. Older servers send only `name`.
                        const label = String(row.label || row.name || row.id || '').trim();
                        const id = row.id != null ? String(row.id) : label;
                        const name = String(row.name || '').trim();
                        const title = name && name !== label ? name : undefined;
                        return label ? { id, label, title } : null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.label.localeCompare(b.label));
                setOptions(opts);
                const grp = (Array.isArray(j.businessUnitGroups) ? j.businessUnitGroups : [])
                    .map((g) => {
                        const id = String((g && g.id) || '').trim();
                        const label = String((g && g.label) || id).trim();
                        if (!id || !label) return null;
                        return {
                            id,
                            label,
                            name: g.name ? String(g.name) : null,
                            parent: g.parent ? String(g.parent).trim() : null,
                            codeCount: Number(g.codeCount) || 0,
                            residual: g.residual === true,
                            subtract: Array.isArray(g.subtract) ? g.subtract.map(String) : [],
                            scopeLabel: g.scopeLabel ? String(g.scopeLabel) : `${label} · region`
                        };
                    })
                    .filter(Boolean);
                setGroups(grp);
                setGroupSelected((prev) => {
                    const known = new Set(grp.map((g) => g.id));
                    const next = new Set([...prev].filter((id) => known.has(id)));
                    if (next.size !== prev.size) persistGroups(next);
                    return next.size !== prev.size ? next : prev;
                });
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
    }, [persist, persistGroups, authLoading, authRequired, user]);

    return { options, groups, error, selected, groupSelected, toggle, toggleGroup, selectAll, clear, selectAllGroups, clearGroups };
}
