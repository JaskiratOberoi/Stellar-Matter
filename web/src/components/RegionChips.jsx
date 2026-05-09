/**
 * @typedef {{ key: string, label: string, mccCount: number }} RegionCityNode
 * @typedef {{ key: string, label: string, mccCount: number, cities: RegionCityNode[] }} RegionStateNode
 */

/**
 * @param {{
 *   states: RegionStateNode[],
 *   loading: boolean,
 *   selectedStates: Set<string>,
 *   selectedCities: Set<string>,
 *   onToggleState: (stateKey: string) => void,
 *   onToggleCity: (cityKey: string) => void,
 *   onClear: () => void,
 *   lookupError: string | null
 * }} props
 */
export function RegionChips({
    states,
    loading,
    selectedStates,
    selectedCities,
    onToggleState,
    onToggleCity,
    onClear,
    lookupError
}) {
    return (
        <div className="field-block region-field-block">
            <div className="row-between bu-chip-toolbar">
                <span className="eyebrow-lite field-label">Regions (State → City)</span>
                <div className="chip-tool-group">
                    <button
                        type="button"
                        className="chip chip-tool"
                        disabled={loading || !states.length || (selectedStates.size === 0 && selectedCities.size === 0)}
                        onClick={onClear}
                    >
                        Clear regions
                    </button>
                </div>
            </div>
            {lookupError && (
                <p className="muted small bu-lookup-msg">
                    Could not load region tree ({lookupError}). Region filter unavailable.
                </p>
            )}
            {loading && <p className="muted small">Loading regions…</p>}
            {!loading && states.length > 0 && (
                <>
                    <div className="chip-grid" role="group" aria-label="State chips">
                        {states.map((st) => (
                            <button
                                key={st.key}
                                type="button"
                                className="chip bu-chip region-state-chip"
                                aria-pressed={selectedStates.has(st.key) ? 'true' : 'false'}
                                title={`${st.mccCount ?? 0} MCC units`}
                                onClick={() => onToggleState(st.key)}
                            >
                                {st.label}
                                <span className="muted small region-chip-count">{st.mccCount ?? 0}</span>
                            </button>
                        ))}
                    </div>
                    {states
                        .filter((st) => selectedStates.has(st.key))
                        .map((st) => (
                            <div key={`cities-${st.key}`} className="region-city-block">
                                <p className="eyebrow-lite field-label region-city-heading">
                                    Cities in {st.label}
                                </p>
                                <div
                                    className="chip-grid region-city-grid"
                                    role="group"
                                    aria-label={`Cities in ${st.label}`}
                                >
                                    {(st.cities || []).map((c) => (
                                        <button
                                            key={c.key}
                                            type="button"
                                            className="chip bu-chip region-city-chip"
                                            aria-pressed={selectedCities.has(c.key) ? 'true' : 'false'}
                                            title={`${c.mccCount ?? 0} MCC units`}
                                            onClick={() => onToggleCity(c.key)}
                                        >
                                            {c.label}
                                            <span className="muted small region-chip-count">{c.mccCount ?? 0}</span>
                                        </button>
                                    ))}
                                </div>
                            </div>
                        ))}
                </>
            )}
        </div>
    );
}
