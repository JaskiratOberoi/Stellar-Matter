import { useCallback, useState } from 'react';
import { LS_TRACER_REGION_SELECTION, readJSON, writeJSON } from '../lib/storage.js';

/**
 * Persisted state + city key selection for Tracer region chips.
 * @returns {{
 *   selectedStates: Set<string>,
 *   selectedCities: Set<string>,
 *   toggleState: (key: string) => void,
 *   toggleCity: (key: string) => void,
 *   clearRegions: () => void,
 *   pruneStale: (validStateKeys: Set<string>, validCityKeys: Set<string>) => void
 * }}
 */
export function useTracerRegionSelection() {
    const hydrate = () => {
        const raw = readJSON(LS_TRACER_REGION_SELECTION, {});
        const s = raw && Array.isArray(raw.stateKeys) ? raw.stateKeys : [];
        const c = raw && Array.isArray(raw.cityKeys) ? raw.cityKeys : [];
        return { states: new Set(s.map(String)), cities: new Set(c.map(String)) };
    };

    const [selectedStates, setSelectedStates] = useState(() => hydrate().states);
    const [selectedCities, setSelectedCities] = useState(() => hydrate().cities);

    const persist = useCallback((nextStates, nextCities) => {
        writeJSON(LS_TRACER_REGION_SELECTION, {
            stateKeys: [...nextStates].sort(),
            cityKeys: [...nextCities].sort()
        });
    }, []);

    const toggleState = useCallback(
        (key) => {
            const k = String(key || '').trim();
            if (!k) return;
            setSelectedStates((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                setSelectedCities((citiesPrev) => {
                    persist(next, citiesPrev);
                    return citiesPrev;
                });
                return next;
            });
        },
        [persist]
    );

    const toggleCity = useCallback(
        (key) => {
            const k = String(key || '').trim();
            if (!k) return;
            setSelectedCities((prev) => {
                const next = new Set(prev);
                if (next.has(k)) next.delete(k);
                else next.add(k);
                setSelectedStates((statesPrev) => {
                    persist(statesPrev, next);
                    return statesPrev;
                });
                return next;
            });
        },
        [persist]
    );

    const clearRegions = useCallback(() => {
        persist(new Set(), new Set());
        setSelectedStates(new Set());
        setSelectedCities(new Set());
    }, [persist]);

    const pruneStale = useCallback(
        (validStateKeys, validCityKeys) => {
            setSelectedStates((prev) => {
                const nextS = new Set();
                for (const sk of prev) if (validStateKeys.has(sk)) nextS.add(sk);
                setSelectedCities((prevC) => {
                    const nextC = new Set();
                    for (const ck of prevC) if (validCityKeys.has(ck)) nextC.add(ck);
                    persist(nextS, nextC);
                    return nextC;
                });
                return nextS;
            });
        },
        [persist]
    );

    return { selectedStates, selectedCities, toggleState, toggleCity, clearRegions, pruneStale };
}
