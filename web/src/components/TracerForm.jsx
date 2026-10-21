import { useEffect, useState } from 'react';
import { DateChips } from './DateChips.jsx';
import { BuChips } from './BuChips.jsx';
import { RegionGroupChips } from './RegionGroupChips.jsx';
import { SalesChips } from './SalesChips.jsx';
import { ClientCodePicker } from './ClientCodePicker.jsx';
import { QUICK_RANGES, fmtDDMMYYYY, fmtDateRange } from '../lib/format.js';

/** localStorage key for the Collate toggle. Survives reload. */
const LS_TRACER_COLLATE = 'lis-nav-bot.tracer.collate';

// The API takes DD/MM/YYYY; the native date picker speaks YYYY-MM-DD.
function ddmmToIso(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim());
    return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

function isoToDdmm(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
}

/** The monthly sweep is the common case, so a fresh form starts on last month. */
function lastMonthWindow() {
    const q = QUICK_RANGES.find((r) => r.id === 'lastMonth');
    if (!q) return { from: '', to: '' };
    const t = q.build();
    return { from: fmtDDMMYYYY(t.from), to: fmtDDMMYYYY(t.to) };
}

/**
 * @param {{
 *   buOptions: { options: { id: string, label: string }[], groups?: { id: string, label: string, parent: string|null, name: string|null, codeCount: number }[], error: string | null },
 *   buSelected: Set<string>,
 *   buGroupSelected?: Set<string>,
 *   buActions: { toggle: (label: string) => void, toggleGroup?: (id: string) => void, selectAll: () => void, clear: () => void, selectAllGroups?: () => void, clearGroups?: () => void },
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
 *     buGroups: { id: string, label: string, parent: string|null, scopeLabel: string }[],
 *     salesPeople: { id: string | number, label: string }[],
 *     clientCodes: string[],
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
    const [fromDate, setFromDate] = useState(() => lastMonthWindow().from);
    const [toDate, setToDate] = useState(() => lastMonthWindow().to);
    const [fromHour, setFromHour] = useState('');
    const [toHour, setToHour] = useState('');
    const [bu, setBu] = useState('');
    const [clientCodes, setClientCodes] = useState(/** @type {{ code: string, name: string|null }[]} */ ([]));
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
    const hasCodePick = clientCodes.length > 0;

    const [scopeTab, setScopeTab] = useState('bu');
    const [scopeQuery, setScopeQuery] = useState('');
    const matchQuery = (list, labelOf) => {
        const q = scopeQuery.trim().toLowerCase();
        return q ? list.filter((x) => String(labelOf(x) || '').toLowerCase().includes(q)) : list;
    };
    const scopeTabs = [
        { id: 'bu', label: 'Business units', count: buSelected.size },
        ...((buOptions.groups || []).length ? [{ id: 'region', label: 'Regions', count: buGroups.length }] : []),
        { id: 'sales', label: 'Sales', count: salesSelectedIds.size },
        { id: 'codes', label: 'Client codes', count: clientCodes.length }
    ];
    // Every pick across the tabs, in run order, each removable from the summary.
    const picks = [
        ...[...buSelected].map((label) => ({
            key: `bu:${label}`, kind: 'bu', kindLabel: 'BU', label, remove: () => buActions.toggle(label)
        })),
        ...buGroups.map((g) => ({
            key: `g:${g.id}`, kind: 'region', kindLabel: 'Region', label: g.label,
            remove: () => buActions.toggleGroup && buActions.toggleGroup(g.id)
        })),
        ...[...salesSelectedIds].map((id) => {
            const meta = salesUsers.find((u) => String(u.userId) === id);
            const label = meta ? meta.label : id;
            return { key: `s:${id}`, kind: 'sales', kindLabel: 'Sales', label, remove: () => salesActions.toggle(id, label) };
        }),
        ...(clientCodes.length
            ? [{
                  key: 'codes', kind: 'codes', kindLabel: 'Codes',
                  label: clientCodes.length <= 3 ? clientCodes.map((c) => c.code).join(', ') : `${clientCodes.length} client codes`,
                  remove: () => setClientCodes([])
              }]
            : [])
    ];

    const fromIso = ddmmToIso(fromDate);
    const toIso = ddmmToIso(toDate);
    const datesBackwards = Boolean(fromIso && toIso && fromIso > toIso);
    const hasScope = hasBuPick || hasGroupPick || hasBuFallback || hasSalesPick || hasCodePick;

    /** At least one of BU chips / BU group / BU text fallback / salesperson / client code — matches server validation */
    const canRun = datesOk && !datesBackwards && hasScope && !viewerDisabled;
    // Say why Run is off instead of leaving a dead button.
    let blockedReason = null;
    if (viewerDisabled) blockedReason = 'Viewer role cannot start runs.';
    else if (!datesOk) blockedReason = 'Pick a date window.';
    else if (datesBackwards) blockedReason = 'The From date is after the To date.';
    else if (!hasScope) blockedReason = 'Pick at least one business unit, region, salesperson or client code.';

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
            buGroups: buGroups.map((g) => ({ id: g.id, label: g.label, parent: g.parent, scopeLabel: g.scopeLabel })),
            salesPeople,
            clientCodes: clientCodes.map((c) => c.code),
            collate
        });
    }

    return (
        <form className="tracer-form nexus-card tracer-hide-print" onSubmit={handleSubmit}>
            {/* Read-only while a run is going, so the picks on screen are the ones running. */}
            <fieldset className="tracer-form-fields" disabled={busy}>
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
                            type="date"
                            value={fromIso}
                            max={toIso || undefined}
                            aria-invalid={datesBackwards ? 'true' : undefined}
                            onChange={(e) => setFromDate(isoToDdmm(e.target.value))}
                        />
                    </label>
                    <label className="inv-field">
                        <span>To date</span>
                        <input
                            type="date"
                            value={toIso}
                            min={fromIso || undefined}
                            aria-invalid={datesBackwards ? 'true' : undefined}
                            onChange={(e) => setToDate(isoToDdmm(e.target.value))}
                        />
                    </label>
                </div>
                {datesBackwards && <p className="login-err tracer-date-err" role="alert">The From date is after the To date.</p>}
                {/* Most runs are whole days; the hour window is there when needed. */}
                <details className="tracer-hours" open={Boolean(fromHour || toHour) || undefined}>
                    <summary>Hour window (optional)</summary>
                    <div className="tracer-date-grid">
                        <label className="inv-field">
                            <span>From hour</span>
                            <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                max="23"
                                placeholder="0"
                                value={fromHour}
                                onChange={(e) => setFromHour(e.target.value)}
                            />
                        </label>
                        <label className="inv-field">
                            <span>To hour</span>
                            <input
                                type="number"
                                inputMode="numeric"
                                min="0"
                                max="23"
                                placeholder="23"
                                value={toHour}
                                onChange={(e) => setToHour(e.target.value)}
                            />
                        </label>
                    </div>
                </details>

                {/* One scope list at a time instead of four open walls of chips;
                    each tab carries its pick count so nothing selected is hidden. */}
                <div className="tracer-scope-tabs" role="tablist" aria-label="Scope">
                    {scopeTabs.map((t) => (
                        <button
                            key={t.id}
                            type="button"
                            role="tab"
                            aria-selected={scopeTab === t.id ? 'true' : 'false'}
                            className={`tracer-scope-tab${scopeTab === t.id ? ' active' : ''}`}
                            onClick={() => {
                                setScopeTab(t.id);
                                setScopeQuery('');
                            }}
                        >
                            {t.label}
                            {t.count > 0 && <span className="tracer-scope-count">{t.count}</span>}
                        </button>
                    ))}
                </div>

                <div className="tracer-scope-panel" role="tabpanel">
                    {(scopeTab === 'bu' || scopeTab === 'sales') && (
                        <input
                            type="search"
                            className="inv-search tracer-scope-search"
                            placeholder={scopeTab === 'bu' ? 'Find a business unit…' : 'Find a salesperson…'}
                            value={scopeQuery}
                            onChange={(e) => setScopeQuery(e.target.value)}
                        />
                    )}
                    {scopeTab === 'bu' && (
                        <BuChips
                            source="sql"
                            options={matchQuery(buOptions.options, (o) => o.label)}
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
                    )}
                    {scopeTab === 'region' && (
                        <RegionGroupChips
                            groups={buOptions.groups || []}
                            selected={buGroupSelected}
                            onToggle={(id) => buActions.toggleGroup && buActions.toggleGroup(id)}
                            onSelectAll={() => buActions.selectAllGroups && buActions.selectAllGroups()}
                            onClear={() => buActions.clearGroups && buActions.clearGroups()}
                        />
                    )}
                    {scopeTab === 'sales' && (
                        <SalesChips
                            users={matchQuery(salesUsers, (u) => u.label)}
                            loading={salesLoading}
                            lookupError={salesLookupError}
                            selectedIds={salesSelectedIds}
                            onToggle={salesActions.toggle}
                            onClear={salesActions.clear}
                        />
                    )}
                    {scopeTab === 'codes' && (
                        <ClientCodePicker
                            selected={clientCodes}
                            onAdd={(item) =>
                                setClientCodes((prev) => (prev.some((c) => c.code === item.code) ? prev : [...prev, item]))
                            }
                            onRemove={(code) => setClientCodes((prev) => prev.filter((c) => c.code !== code))}
                            onClear={() => setClientCodes([])}
                        />
                    )}
                </div>

                {/* What Run will do, before it does it: every pick across all four
                    tabs, removable here, plus the window and the block shape. */}
                <div className="tracer-willrun" aria-live="polite">
                    <p className="tracer-willrun-head">
                        <span className="eyebrow-lite">Will run</span>
                        <span>
                            {datesOk ? fmtDateRange(fromDate, toDate) : 'no date window'}
                            {fromHour || toHour ? ` · hours ${fromHour || '0'}–${toHour || '23'}` : ''}
                            {' · '}
                            {picks.length === 0
                                ? 'nothing picked yet'
                                : collate
                                  ? `${picks.length} scope${picks.length === 1 ? '' : 's'} merged into 1 block`
                                  : `${picks.length} block${picks.length === 1 ? '' : 's'}`}
                        </span>
                    </p>
                    {picks.length > 0 && (
                        <div className="tracer-willrun-chips">
                            {picks.map((p) => (
                                <span key={p.key} className={`tracer-pick tracer-pick-${p.kind}`}>
                                    <span className="tracer-pick-kind">{p.kindLabel}</span>
                                    {p.label}
                                    <button type="button" aria-label={`Remove ${p.label}`} onClick={p.remove} disabled={busy}>
                                        ×
                                    </button>
                                </span>
                            ))}
                        </div>
                    )}
                </div>
            </fieldset>

            <div className="tracer-form-actions">
                <button type="submit" className="btn-primary" disabled={!canRun || busy}>
                    {busy ? 'Running…' : 'Run tracer'}
                </button>
                <div className="tracer-collate" role="radiogroup" aria-label="Result blocks">
                    <button
                        type="button"
                        role="radio"
                        aria-checked={!collate ? 'true' : 'false'}
                        className={`chip chip-tool${!collate ? ' active' : ''}`}
                        disabled={busy}
                        onClick={() => setCollate(false)}
                    >
                        Separate blocks
                    </button>
                    <button
                        type="button"
                        role="radio"
                        aria-checked={collate ? 'true' : 'false'}
                        className={`chip chip-tool${collate ? ' active' : ''}`}
                        disabled={busy}
                        onClick={() => setCollate(true)}
                    >
                        One merged block
                    </button>
                    <span className="muted small tracer-collate-note">
                        {collate ? 'Samples counted once across every pick' : 'One block per unit, region, person or code list'}
                    </span>
                </div>
                {blockedReason && !busy && <p className="muted small tracer-run-blocked">{blockedReason}</p>}
            </div>
        </form>
    );
}
