/**
 * @typedef {{ key: string, label: string, mccCount: number, codes?: string[] }} RegionCityNode
 * @typedef {{ key: string, label: string, mccCount: number, cities: RegionCityNode[] }} RegionStateNode
 */

const CITY_CODE_TOOLTIP_LIMIT = 40;

/** Build the city chip tooltip text: count + sorted MCC codes (capped). */
function buildCityTitle(city) {
    const count = city.mccCount ?? 0;
    const codes = Array.isArray(city.codes) ? city.codes : [];
    const head = `${count} MCC unit${count === 1 ? '' : 's'}`;
    if (codes.length === 0) return head;
    if (codes.length <= CITY_CODE_TOOLTIP_LIMIT) {
        return `${head}\n${codes.join(', ')}`;
    }
    const shown = codes.slice(0, CITY_CODE_TOOLTIP_LIMIT).join(', ');
    return `${head}\n${shown}\n+ ${codes.length - CITY_CODE_TOOLTIP_LIMIT} more`;
}

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
                    <p className="muted small region-help-text">
                        Selecting a <strong>state</strong> runs the whole state as one report.
                        To run only specific <strong>cities</strong>, select the state to reveal
                        its cities, click the cities you want, then click the state again to
                        unselect it — the chosen cities stay selected and run on their own.
                    </p>
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
                        .filter(
                            (st) =>
                                selectedStates.has(st.key) ||
                                (st.cities || []).some((c) => selectedCities.has(c.key))
                        )
                        .map((st) => {
                            const stateSelected = selectedStates.has(st.key);
                            const citySelectedCount = (st.cities || []).filter((c) =>
                                selectedCities.has(c.key)
                            ).length;
                            return (
                                <div key={`cities-${st.key}`} className="region-city-block">
                                    <p className="eyebrow-lite field-label region-city-heading">
                                        Cities in {st.label}
                                        {!stateSelected && citySelectedCount > 0 && (
                                            <span className="muted small region-city-subnote">
                                                {' '}
                                                — state unselected; {citySelectedCount === 1 ? '1 city' : `${citySelectedCount} cities`} will run
                                            </span>
                                        )}
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
                                                title={buildCityTitle(c)}
                                                onClick={() => onToggleCity(c.key)}
                                            >
                                                {c.label}
                                                <span className="muted small region-chip-count">{c.mccCount ?? 0}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            );
                        })}
                </>
            )}
        </div>
    );
}
