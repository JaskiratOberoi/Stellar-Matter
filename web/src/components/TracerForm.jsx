import { useEffect, useState } from 'react';
import { DateChips } from './DateChips.jsx';
import { BuChips } from './BuChips.jsx';
import { SalesChips } from './SalesChips.jsx';

/** localStorage key for the Collate toggle. Survives reload. */
const LS_TRACER_COLLATE = 'lis-nav-bot.tracer.collate';

/**
 * @param {{
 *   buOptions: { options: { id: string, label: string }[], groups?: { id: string, label: string, parent: string|null, name: string|null, codeCount: number }[], error: string | null },
 *   buSelected: Set<string>,
 *   buGroupSelected?: Set<string>,
 *   buActions: { toggle: (label: string) => void, toggleGroup?: (id: string) => void, selectAll: () => void, clear: () => void },
 *   salesUsers: { userId: number, label: string, codeCount?: number }[],
 *   salesLoading: boolean,
 *   salesLookupError: string | null,
 *   salesSelectedIds: Set<string>,
 *   salesActions: { toggle: (userId: string, label: string) => void, clear: () => void },
 *   busy: boolean,
 *   viewerDisabled: boolean,
 *   onRun: (form: {
 *     fromDate: string,
 *     toDate: string,
 *     fromHour: string,
 *     toHour: string,
 *     bu: string,
 *     businessUnits: string[],
 *     buGroups: { id: string, label: string, parent: string|null }[],
 *     salesPeople: { id: string | number, label: string }[],
 *     collate: boolean,
 *   }) => void | Promise<void>,
 * }} props
 */
export function TracerForm({
    buOptions,
    buSelected,
    buGroupSelected = new Set(),
    buActions,
    salesUsers,
    salesLoading,
    salesLookupError,
    salesSelectedIds,
    salesActions,
    busy,
    viewerDisabled,
    onRun
}) {
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [fromHour, setFromHour] = useState('');
    const [toHour, setToHour] = useState('');
    const [bu, setBu] = useState('');
    const [collate, setCollate] = useState(() => {
        try {
            return localStorage.getItem(LS_TRACER_COLLATE) === '1';
        } catch {
            return false;
        }
    });

    useEffect(() => {
        try {
            if (collate) localStorage.setItem(LS_TRACER_COLLATE, '1');
            else localStorage.removeItem(LS_TRACER_COLLATE);
        } catch {
            // localStorage may be unavailable (private mode); just skip persistence.
        }
    }, [collate]);

    const datesOk = String(fromDate || '').trim() !== '' && String(toDate || '').trim() !== '';
    const hasBuPick = buSelected.size > 0;
    const hasBuFallback = buOptions.options.length === 0 && String(bu || '').trim() !== '';
    const hasSalesPick = salesSelectedIds.size > 0;
    const buGroups = (buOptions.groups || []).filter((g) => buGroupSelected.has(g.id));
    const hasGroupPick = buGroups.length > 0;

    /** At least one of BU chips / BU group / BU text fallback / salesperson — matches server validation */
    const canRun = datesOk && (hasBuPick || hasGroupPick || hasBuFallback || hasSalesPick) && !viewerDisabled;

    async function handleSubmit(e) {
        e.preventDefault();
        if (!canRun || busy) return;
        const businessUnits = hasBuPick ? [...buSelected] : [];
        const salesPeople = [];
        for (const id of salesSelectedIds) {
            const meta = salesUsers.find((u) => String(u.userId) === id);
            salesPeople.push({ id, label: meta ? meta.label : id });
        }
        await onRun({
            fromDate,
            toDate,
            fromHour,
            toHour,
            bu,
            businessUnits,
            buGroups: buGroups.map((g) => ({ id: g.id, label: g.label, parent: g.parent })),
            salesPeople,
            collate
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
            <div className="tracer-date-grid">
                <label className="inv-field">
                    <span>From date</span>
                    <input
                        type="text"
                        inputMode="numeric"
                        placeholder="DD/MM/YYYY"
                        value={fromDate}
                        onChange={(e) => setFromDate(e.target.value)}
                    />
                </label>
                <label className="inv-field">
                    <span>To date</span>
                    <input
                        type="text"
                        inputMode="numeric"
                        placeholder="DD/MM/YYYY"
                        value={toDate}
                        onChange={(e) => setToDate(e.target.value)}
                    />
                </label>
                <label className="inv-field">
                    <span>From hour</span>
                    <input
                        type="number"
                        min="0"
                        max="23"
                        placeholder="00"
                        value={fromHour}
                        onChange={(e) => setFromHour(e.target.value)}
                    />
                </label>
                <label className="inv-field">
                    <span>To hour</span>
                    <input
                        type="number"
                        min="0"
                        max="23"
                        placeholder="24"
                        value={toHour}
                        onChange={(e) => setToHour(e.target.value)}
                    />
                </label>
            </div>

            <BuChips
                groups={buOptions.groups || []}
                groupSelected={buGroupSelected}
                onToggleGroup={buActions.toggleGroup}
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

            <SalesChips
                users={salesUsers}
                loading={salesLoading}
                lookupError={salesLookupError}
                selectedIds={salesSelectedIds}
                onToggle={salesActions.toggle}
                onClear={salesActions.clear}
            />

            <div className="tracer-form-actions">
                <button type="submit" className="btn-primary" disabled={!canRun || busy}>
                    {busy ? 'Running…' : 'Run tracer'}
                </button>
                <label
                    className="inv-toggle"
                    title={
                        collate
                            ? 'Collate on — all selected BUs and sales scopes merge into one SID-deduped block.'
                            : 'Collate off — each BU and each salesperson gets its own block.'
                    }
                >
                    <input
                        type="checkbox"
                        className="inv-toggle-input"
                        checked={collate}
                        disabled={busy}
                        onChange={(e) => setCollate(e.target.checked)}
                    />
                    <span className="inv-toggle-track" aria-hidden="true">
                        <span className="inv-toggle-thumb" />
                    </span>
                    <span className="inv-toggle-label">Collate into one block</span>
                </label>
                {viewerDisabled && <p className="muted small">Viewer role cannot start runs.</p>}
            </div>
        </form>
    );
}
