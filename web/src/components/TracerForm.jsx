import { useState } from 'react';
import { DateChips } from './DateChips.jsx';
import { BuChips } from './BuChips.jsx';
import { RegionChips } from './RegionChips.jsx';

/**
 * @param {{
 *   buOptions: { options: { id: string, label: string }[], error: string | null },
 *   buSelected: Set<string>,
 *   buActions: { toggle: (label: string) => void, selectAll: () => void, clear: () => void },
 *   regionStates: { key: string, label: string, cities?: { key: string, label: string, mccCount?: number }[], mccCount?: number }[],
 *   regionLoading: boolean,
 *   regionLookupError: string | null,
 *   regionSelectedStates: Set<string>,
 *   regionSelectedCities: Set<string>,
 *   regionActions: { toggleState: (k: string) => void, toggleCity: (k: string) => void, clearRegions: () => void },
 *   busy: boolean,
 *   viewerDisabled: boolean,
 *   onRun: (form: {
 *     fromDate: string,
 *     toDate: string,
 *     fromHour: string,
 *     toHour: string,
 *     bu: string,
 *     businessUnits: string[],
 *     regionStatesTree: unknown[],
 *     selectedRegions: { states: Set<string>, cities: Set<string> }
 *   }) => void | Promise<void>,
 * }} props
 */
export function TracerForm({
    buOptions,
    buSelected,
    buActions,
    regionStates,
    regionLoading,
    regionLookupError,
    regionSelectedStates,
    regionSelectedCities,
    regionActions,
    busy,
    viewerDisabled,
    onRun
}) {
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [fromHour, setFromHour] = useState('');
    const [toHour, setToHour] = useState('');
    const [bu, setBu] = useState('');

    const datesOk = String(fromDate || '').trim() !== '' && String(toDate || '').trim() !== '';
    const hasBuPick = buSelected.size > 0;
    const hasBuFallback = buOptions.options.length === 0 && String(bu || '').trim() !== '';
    const hasRegionPick = regionSelectedStates.size > 0 || regionSelectedCities.size > 0;

    /** At least one of BU chips / BU text fallback / geography chips — matches server validation */
    const canRun = datesOk && (hasBuPick || hasBuFallback || hasRegionPick) && !viewerDisabled;

    async function handleSubmit(e) {
        e.preventDefault();
        if (!canRun || busy) return;
        const businessUnits = hasBuPick ? [...buSelected] : [];
        await onRun({
            fromDate,
            toDate,
            fromHour,
            toHour,
            bu,
            businessUnits,
            regionStatesTree: regionStates,
            selectedRegions: { states: regionSelectedStates, cities: regionSelectedCities }
        });
    }

    return (
        <form className="tracer-form nexus-card tracer-hide-print" onSubmit={handleSubmit}>
            <div className="field-block tracer-form-first-field">
                <span className="eyebrow-lite field-label">Date quick picks</span>
                <DateChips
                    fromDate={fromDate}
                    toDate={toDate}
                    onPick={({ from, to }) => {
                        setFromDate(from);
                        setToDate(to);
                    }}
                />
            </div>
            <div className="grid2 sidebar-grid tracer-date-grid">
                <label>
                    From date{' '}
                    <input
                        type="text"
                        placeholder="DD/MM/YYYY"
                        value={fromDate}
                        onChange={(e) => setFromDate(e.target.value)}
                    />
                </label>
                <label>
                    To date{' '}
                    <input
                        type="text"
                        placeholder="DD/MM/YYYY"
                        value={toDate}
                        onChange={(e) => setToDate(e.target.value)}
                    />
                </label>
                <label>
                    From hour{' '}
                    <input
                        type="number"
                        min="0"
                        max="23"
                        value={fromHour}
                        onChange={(e) => setFromHour(e.target.value)}
                    />
                </label>
                <label>
                    To hour{' '}
                    <input
                        type="number"
                        min="0"
                        max="23"
                        value={toHour}
                        onChange={(e) => setToHour(e.target.value)}
                    />
                </label>
            </div>

            <BuChips
                source="sql"
                options={buOptions.options}
                selected={buSelected}
                onToggle={buActions.toggle}
                onSelectAll={buActions.selectAll}
                onClear={buActions.clear}
                lookupError={buOptions.error}
                freeTextField={
                    <input
                        type="text"
                        placeholder="ROHTAK or id"
                        autoComplete="off"
                        value={bu}
                        onChange={(e) => setBu(e.target.value)}
                    />
                }
            />

            <RegionChips
                states={regionStates}
                loading={regionLoading}
                selectedStates={regionSelectedStates}
                selectedCities={regionSelectedCities}
                onToggleState={regionActions.toggleState}
                onToggleCity={regionActions.toggleCity}
                onClear={regionActions.clearRegions}
                lookupError={regionLookupError}
            />

            <div className="tracer-form-actions">
                <button type="submit" className="btn-primary" disabled={!canRun || busy}>
                    {busy ? 'Running…' : 'Run tracer'}
                </button>
                {viewerDisabled && <p className="muted small">Viewer role cannot start runs.</p>}
            </div>
        </form>
    );
}
