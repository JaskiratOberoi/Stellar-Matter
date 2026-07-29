import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useBuOptions } from '../hooks/useBuOptions.js';
import { useInventory } from '../hooks/useInventory.js';

const ALL_BUS_DEST = '__all_bus__';

const CATALOG_ROLES = new Set(['super_admin', 'admin']);
const MOVER_ROLES = new Set(['super_admin', 'admin', 'operator']);

const VIEWS = [
    { id: 'stock', label: 'Stock', icon: 'grid', caption: 'On-hand matrix' },
    { id: 'receive', label: 'Receive', icon: 'in', caption: 'Vendor intake' },
    { id: 'dispatch', label: 'Dispatch', icon: 'out', caption: 'Ship & transfer' },
    { id: 'ledger', label: 'Ledger', icon: 'list', caption: 'Movement history' },
    { id: 'catalog', label: 'Catalog', icon: 'tag', caption: 'Materials & sites', adminOnly: true }
];

function fmt(n) {
    return Number(n || 0).toLocaleString();
}

function balanceKey(materialId, locationId) {
    return `${materialId}|${locationId}`;
}

function kindLabel(kind) {
    if (kind === 'business_unit') return 'BU';
    if (kind === 'store') return 'Store';
    if (kind === 'lab') return 'Lab';
    return kind;
}

function kindDot(kind) {
    return kind === 'business_unit' ? 'bu' : kind === 'store' ? 'store' : 'lab';
}

function useBalanceMap(balances) {
    return useMemo(() => {
        const map = new Map();
        for (const b of balances) map.set(balanceKey(b.material_id, b.location_id), Number(b.on_hand) || 0);
        return map;
    }, [balances]);
}

// Compact inline icon set — keeps the nav/summary legible without a dependency.
function Icon({ name, className }) {
    const p = {
        width: 16,
        height: 16,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.8,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        className
    };
    switch (name) {
        case 'grid':
            return (<svg {...p}><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>);
        case 'in':
            return (<svg {...p}><path d="M12 3v12" /><path d="m7 10 5 5 5-5" /><path d="M5 21h14" /></svg>);
        case 'out':
            return (<svg {...p}><path d="M12 21V9" /><path d="m7 14 5-5 5 5" /><path d="M5 3h14" /></svg>);
        case 'list':
            return (<svg {...p}><path d="M8 6h13" /><path d="M8 12h13" /><path d="M8 18h13" /><path d="M3 6h.01" /><path d="M3 12h.01" /><path d="M3 18h.01" /></svg>);
        case 'tag':
            return (<svg {...p}><path d="M3 7v5l9 9 5-5-9-9H3z" /><circle cx="7" cy="11" r="1.4" /></svg>);
        case 'box':
            return (<svg {...p}><path d="M21 8 12 3 3 8l9 5 9-5z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>);
        case 'warn':
            return (<svg {...p}><path d="M12 9v4" /><path d="M12 17h.01" /><path d="M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /></svg>);
        default:
            return null;
    }
}

// Section rule: kicker number, title, caption on the left; tools on the right.
function SectionHead({ index, title, caption, children }) {
    return (
        <div className="inv-sechead">
            <div className="inv-sechead-text">
                <h2 className="inv-sechead-title">
                    {index && <span className="inv-sechead-n">{index}</span>}
                    {title}
                </h2>
                {caption && <p className="inv-sechead-cap">{caption}</p>}
            </div>
            {children && <div className="inv-sechead-tools">{children}</div>}
        </div>
    );
}

// Numbered form movement — breaks a long form into scannable editorial blocks.
function FormStep({ n, title, hint, children }) {
    return (
        <fieldset className="inv-fs">
            <legend className="inv-fs-head">
                <span className="inv-fs-n">{n}</span>
                <span className="inv-fs-title">{title}</span>
                {hint && <span className="inv-fs-hint">{hint}</span>}
            </legend>
            <div className="inv-fs-grid">{children}</div>
        </fieldset>
    );
}

export function InventoryPage() {
    const { user, authRequired } = useAuth();
    const inventory = useInventory();
    const [view, setView] = useState('stock');
    const [flash, setFlash] = useState(null);
    const [seeding, setSeeding] = useState(false);

    const role = user ? user.role : null;
    const canManageCatalog = !authRequired || (role && CATALOG_ROLES.has(role));
    const canMove = !authRequired || (role && MOVER_ROLES.has(role));

    const showFlash = useCallback((msg) => {
        setFlash(msg);
        window.clearTimeout(showFlash._t);
        showFlash._t = window.setTimeout(() => setFlash(null), 4500);
    }, []);

    const activeMaterials = inventory.materials.filter((m) => m.active);
    const activeLocations = inventory.locations.filter((l) => l.active);
    const hasStore = activeLocations.some((l) => l.kind === 'store');
    const isFresh = !inventory.loading && activeMaterials.length === 0 && activeLocations.length === 0;

    const handleSeed = useCallback(async () => {
        setSeeding(true);
        try {
            const r = await inventory.seedDefaults();
            await inventory.reload();
            showFlash(
                `Starter catalog ready — added ${fmt(r.materialsAdded)} materials and a Central Store. Use Receive to add stock.`
            );
            setView('stock');
        } catch (e) {
            showFlash(String(e.message || e));
        } finally {
            setSeeding(false);
        }
    }, [inventory, showFlash]);

    const visibleViews = VIEWS.filter((v) => !v.adminOnly || canManageCatalog);

    const goto = useCallback((v) => setView(v), []);

    return (
        <main className="inv-shell">
            <header className="inv-masthead">
                <div className="inv-masthead-lede">
                    <p className="inv-kicker">Materials · Stellar Matter</p>
                    <h1 className="inv-title">Inventory Tracker</h1>
                </div>
                <div className="inv-masthead-deck">
                    <p className="inv-deck">
                        Receipts add stock to the central store; dispatches move it to a business unit
                        or lab and deduct automatically.
                    </p>
                    <p className="inv-deck-note">
                        Balances derive from an append-only ledger, so they never drift.
                    </p>
                </div>
            </header>

            {flash && <div className="inv-flash">{flash}</div>}
            {inventory.error && <div className="results-error nexus-card">{inventory.error}</div>}

            {inventory.loading ? (
                <div className="inv-loading muted">Loading inventory…</div>
            ) : isFresh ? (
                <OnboardingBoard
                    canManageCatalog={canManageCatalog}
                    seeding={seeding}
                    onSeed={handleSeed}
                    onManual={() => goto('catalog')}
                />
            ) : (
                <>
                    <FiguresStrip summary={inventory.summary} onLowStock={() => goto('stock')} />

                    <nav className="inv-index" role="tablist" aria-label="Inventory views">
                        {visibleViews.map((v, i) => (
                            <button
                                key={v.id}
                                type="button"
                                role="tab"
                                aria-selected={view === v.id ? 'true' : 'false'}
                                className={`inv-index-item${view === v.id ? ' active' : ''}`}
                                onClick={() => setView(v.id)}
                            >
                                <span className="inv-index-n">{String(i + 1).padStart(2, '0')}</span>
                                <span className="inv-index-body">
                                    <span className="inv-index-label">
                                        <Icon name={v.icon} />
                                        {v.label}
                                    </span>
                                    <span className="inv-index-cap">{v.caption}</span>
                                </span>
                            </button>
                        ))}
                    </nav>

                    {canManageCatalog && !hasStore && view !== 'catalog' && (
                        <div className="inv-banner">
                            <Icon name="warn" />
                            <span>
                                No central store yet — receipts and dispatches need one.{' '}
                                <button type="button" className="inv-linkbtn" onClick={() => goto('catalog')}>
                                    Add a store in Catalog
                                </button>{' '}
                                or{' '}
                                <button type="button" className="inv-linkbtn" onClick={handleSeed} disabled={seeding}>
                                    {seeding ? 'setting up…' : 'create the starter catalog'}
                                </button>
                                .
                            </span>
                        </div>
                    )}

                    <div className="inv-view">
                        {view === 'stock' && <StockView inventory={inventory} onGoto={goto} />}
                        {view === 'receive' && (
                            <ReceiveView inventory={inventory} canMove={canMove} onDone={showFlash} onGoto={goto} />
                        )}
                        {view === 'dispatch' && (
                            <DispatchView inventory={inventory} canMove={canMove} onDone={showFlash} onGoto={goto} />
                        )}
                        {view === 'ledger' && <LedgerView inventory={inventory} canMove={canMove} onDone={showFlash} />}
                        {view === 'catalog' && canManageCatalog && (
                            <CatalogView inventory={inventory} onDone={showFlash} seeding={seeding} onSeed={handleSeed} />
                        )}
                    </div>
                </>
            )}
        </main>
    );
}

// -- Onboarding ------------------------------------------------------------

function OnboardingBoard({ canManageCatalog, seeding, onSeed, onManual }) {
    return (
        <section className="inv-board">
            <div className="inv-board-head">
                <div>
                    <p className="inv-kicker">Getting started</p>
                    <h2 className="inv-board-title">Set up your inventory</h2>
                    <p className="inv-deck">
                        This organisation has no stock catalog yet. Three steps put the ledger to work.
                    </p>
                </div>
                {canManageCatalog ? (
                    <div className="inv-board-actions">
                        <button type="button" className="btn-primary" onClick={onSeed} disabled={seeding}>
                            {seeding ? 'Setting up…' : 'Create starter catalog'}
                        </button>
                        <button type="button" className="chip chip-tool" onClick={onManual} disabled={seeding}>
                            Add manually instead
                        </button>
                    </div>
                ) : (
                    <p className="muted small">No catalog is set up. Ask an admin to create one.</p>
                )}
            </div>

            <ol className="inv-board-steps">
                <li className="inv-board-step">
                    <span className="inv-board-n">01</span>
                    <h3>Create the catalog</h3>
                    <p className="muted small">Materials to track, and a central store to hold them.</p>
                </li>
                <li className="inv-board-step">
                    <span className="inv-board-n">02</span>
                    <h3>Receive stock</h3>
                    <p className="muted small">Record vendor deliveries into the store as packs or units.</p>
                </li>
                <li className="inv-board-step">
                    <span className="inv-board-n">03</span>
                    <h3>Dispatch to BUs / labs</h3>
                    <p className="muted small">Stock deducts automatically as it ships out.</p>
                </li>
            </ol>

            <p className="inv-board-foot muted small">
                The starter catalog adds 12 standard materials (letter heads, envelopes, vials, tubes…)
                and a Central Store. You can edit or add more anytime.
            </p>
        </section>
    );
}

// -- Figures ---------------------------------------------------------------

function FiguresStrip({ summary, onLowStock }) {
    if (!summary) return null;
    const low = summary.low_stock ? summary.low_stock.length : 0;
    return (
        <section className="inv-figures" aria-label="Inventory at a glance">
            <div className="inv-figure">
                <span className="inv-figure-num">{fmt(summary.materials)}</span>
                <span className="inv-figure-label">Active materials</span>
                <span className="inv-figure-cap">tracked in the catalog</span>
            </div>
            <div className="inv-figure">
                <span className="inv-figure-num">{fmt(summary.locations)}</span>
                <span className="inv-figure-label">Locations</span>
                <span className="inv-figure-cap">stores, BUs and labs</span>
            </div>
            <div className="inv-figure">
                <span className="inv-figure-num">{fmt(summary.movements)}</span>
                <span className="inv-figure-label">Ledger entries</span>
                <span className="inv-figure-cap">receipts and dispatches</span>
            </div>
            <button
                type="button"
                className={`inv-figure inv-figure-btn${low ? ' is-alert' : ''}`}
                onClick={low ? onLowStock : undefined}
                title={low ? 'View stock' : 'All materials above reorder level'}
            >
                <span className="inv-figure-num">{fmt(low)}</span>
                <span className="inv-figure-label">Below reorder</span>
                <span className="inv-figure-cap">
                    {low ? 'needs restocking' : 'all above reorder level'}
                </span>
            </button>
        </section>
    );
}

// -- Empty-state helper ----------------------------------------------------

function EmptyState({ icon = 'box', title, children, action }) {
    return (
        <div className="inv-empty">
            <div className="inv-empty-icon">
                <Icon name={icon} />
            </div>
            <h3>{title}</h3>
            {children && <p className="muted">{children}</p>}
            {action}
        </div>
    );
}

// -- Stock matrix ----------------------------------------------------------

function StockView({ inventory, onGoto }) {
    const { materials, locations, balances } = inventory;
    const activeMaterials = materials.filter((m) => m.active);
    const activeLocations = locations.filter((l) => l.active);
    const balMap = useBalanceMap(balances);
    const [query, setQuery] = useState('');
    const [hideEmpty, setHideEmpty] = useState(false);

    const storeIds = useMemo(
        () => new Set(activeLocations.filter((l) => l.kind === 'store').map((l) => l.id)),
        [activeLocations]
    );

    const totalFor = useCallback(
        (materialId) => activeLocations.reduce((s, l) => s + (balMap.get(balanceKey(materialId, l.id)) || 0), 0),
        [activeLocations, balMap]
    );

    const rows = useMemo(() => {
        const q = query.trim().toLowerCase();
        return activeMaterials.filter((m) => {
            if (q && !m.name.toLowerCase().includes(q)) return false;
            if (hideEmpty && totalFor(m.id) === 0) return false;
            return true;
        });
    }, [activeMaterials, query, hideEmpty, totalFor]);

    if (!activeMaterials.length || !activeLocations.length) {
        return (
            <EmptyState
                title="Nothing to show yet"
                action={
                    <button type="button" className="btn-primary" onClick={() => onGoto('catalog')}>
                        Go to Catalog
                    </button>
                }
            >
                Add materials and at least one location in the Catalog to start tracking stock.
            </EmptyState>
        );
    }

    const colTotal = (locId) => rows.reduce((s, m) => s + (balMap.get(balanceKey(m.id, locId)) || 0), 0);
    const grandTotal = activeLocations.reduce((s, l) => s + colTotal(l.id), 0);

    return (
        <section className="inv-panel">
            <SectionHead
                title="Stock on hand"
                caption={`${fmt(rows.length)} of ${fmt(activeMaterials.length)} materials across ${fmt(activeLocations.length)} locations`}
            >
                <input
                    className="inv-search"
                    type="search"
                    placeholder="Filter materials…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
                <label className="inv-toggle">
                    <input
                        type="checkbox"
                        className="inv-toggle-input"
                        checked={hideEmpty}
                        onChange={(e) => setHideEmpty(e.target.checked)}
                    />
                    <span className="inv-toggle-track" aria-hidden="true">
                        <span className="inv-toggle-thumb" />
                    </span>
                    <span className="inv-toggle-label">Hide zero rows</span>
                </label>
            </SectionHead>

            <div className="inv-table-wrap">
                <table className="inv-matrix">
                    <thead>
                        <tr>
                            <th className="sticky-col">Material</th>
                            {activeLocations.map((l) => (
                                <th key={l.id} className="num">
                                    <span className="inv-col-name">{l.name}</span>
                                    <span className="inv-col-kind">
                                        <span className={`inv-dot inv-dot-${kindDot(l.kind)}`} />
                                        {kindLabel(l.kind)}
                                    </span>
                                </th>
                            ))}
                            <th className="num inv-total-col">Total</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((m) => (
                            <tr key={m.id}>
                                <td className="sticky-col">
                                    <span className="inv-mat-name">{m.name}</span>
                                    <span className="inv-unit">{m.base_unit}</span>
                                </td>
                                {activeLocations.map((l) => {
                                    const val = balMap.get(balanceKey(m.id, l.id)) || 0;
                                    const low = storeIds.has(l.id) && m.reorder_level > 0 && val < m.reorder_level;
                                    return (
                                        <td
                                            key={l.id}
                                            className={`num${val === 0 ? ' inv-zero' : ''}${low ? ' inv-low' : ''}`}
                                            title={low ? `Below reorder level (${fmt(m.reorder_level)})` : undefined}
                                        >
                                            {val === 0 ? '·' : fmt(val)}
                                        </td>
                                    );
                                })}
                                <td className="num inv-total-col">{fmt(totalFor(m.id))}</td>
                            </tr>
                        ))}
                        {!rows.length && (
                            <tr>
                                <td colSpan={activeLocations.length + 2} className="muted inv-nomatch">
                                    No materials match “{query}”.
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {rows.length > 0 && (
                        <tfoot>
                            <tr>
                                <td className="sticky-col">Total</td>
                                {activeLocations.map((l) => (
                                    <td key={l.id} className="num">{fmt(colTotal(l.id))}</td>
                                ))}
                                <td className="num inv-total-col">{fmt(grandTotal)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </section>
    );
}

// -- Receive ---------------------------------------------------------------

function ReceiveView({ inventory, canMove, onDone, onGoto }) {
    const { materials, locations, balances, createMovement, reload } = inventory;
    const activeMaterials = materials.filter((m) => m.active);
    const activeLocations = locations.filter((l) => l.active);
    const stores = activeLocations.filter((l) => l.kind === 'store');
    const balMap = useBalanceMap(balances);

    const [materialId, setMaterialId] = useState('');
    const [toLocationId, setToLocationId] = useState('');
    const [packSize, setPackSize] = useState('');
    const [packQty, setPackQty] = useState('');
    const [vendor, setVendor] = useState('');
    const [reference, setReference] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    const material = activeMaterials.find((m) => m.id === materialId) || null;

    useEffect(() => {
        if (!toLocationId && stores.length) setToLocationId(stores[0].id);
    }, [stores, toLocationId]);
    useEffect(() => {
        if (material) setPackSize(String(material.default_pack_size || 1));
    }, [material]);

    const total = (Number(packSize) || 0) * (Number(packQty) || 0);
    const current = materialId && toLocationId ? balMap.get(balanceKey(materialId, toLocationId)) || 0 : 0;
    const unit = material ? material.base_unit : 'units';
    const destination = activeLocations.find((l) => l.id === toLocationId) || null;

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!materialId) return setErr('Select a material.');
        if (!toLocationId) return setErr('Select a destination.');
        if (!(Number(packQty) > 0)) return setErr('Enter how many packs were received.');
        setBusy(true);
        try {
            await createMovement({
                kind: 'receipt',
                material_id: materialId,
                to_location_id: toLocationId,
                pack_size: Number(packSize) || 1,
                pack_qty: Number(packQty),
                vendor: vendor || undefined,
                reference: reference || undefined,
                note: note || undefined
            });
            await reload();
            onDone(`Received ${fmt(total)} ${unit} of ${material ? material.name : ''}.`);
            setPackQty('');
            setReference('');
            setNote('');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    if (!canMove) return <ReadOnlyNotice />;
    if (!activeMaterials.length || !stores.length) {
        return (
            <EmptyState
                icon="in"
                title="Set up a store first"
                action={
                    <button type="button" className="btn-primary" onClick={() => onGoto('catalog')}>
                        Go to Catalog
                    </button>
                }
            >
                You need at least one material and a store location before recording receipts.
            </EmptyState>
        );
    }

    return (
        <div className="inv-form-layout">
            <section className="inv-panel">
                <SectionHead title="Receive from vendor" caption="Logs an inbound receipt against the ledger" />
                <form id="inv-receive-form" className="inv-form" onSubmit={onSubmit}>
                    <FormStep n="01" title="What arrived" hint="Material and where it lands">
                        <label className="inv-field">
                            <span>Material</span>
                            <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} required>
                                <option value="">— select —</option>
                                {activeMaterials.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="inv-field">
                            <span>Destination</span>
                            <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} required>
                                <option value="">— select —</option>
                                {activeLocations.map((l) => (
                                    <option key={l.id} value={l.id}>{l.name}</option>
                                ))}
                            </select>
                        </label>
                    </FormStep>

                    <FormStep
                        n="02"
                        title="How much"
                        hint={total > 0 ? `= ${fmt(total)} ${unit}` : `Counted in ${unit}`}
                    >
                        <label className="inv-field">
                            <span>Pack size ({unit}/pack)</span>
                            <input type="number" min="1" value={packSize} onChange={(e) => setPackSize(e.target.value)} />
                        </label>
                        <label className="inv-field">
                            <span>Number of packs</span>
                            <input type="number" min="1" value={packQty} onChange={(e) => setPackQty(e.target.value)} required />
                        </label>
                    </FormStep>

                    <FormStep n="03" title="Paperwork" hint="Optional, but useful in the audit trail">
                        <label className="inv-field">
                            <span>Vendor</span>
                            <input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Optional" />
                        </label>
                        <label className="inv-field">
                            <span>Reference / invoice #</span>
                            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
                        </label>
                        <label className="inv-field inv-field-wide">
                            <span>Note</span>
                            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                        </label>
                    </FormStep>
                </form>
            </section>

            <aside className="inv-docket">
                <p className="inv-docket-head">Receipt preview</p>
                <div className="inv-docket-big">
                    +{fmt(total)}
                    <span className="inv-docket-unit">{unit}</span>
                </div>
                <dl className="inv-docket-dl">
                    <div><dt>Material</dt><dd>{material ? material.name : '—'}</dd></div>
                    <div><dt>Destination</dt><dd>{destination ? destination.name : '—'}</dd></div>
                    <div>
                        <dt>Packs</dt>
                        <dd>{packQty ? `${fmt(Number(packQty))} × ${fmt(Number(packSize) || 0)}` : '—'}</dd>
                    </div>
                    <div><dt>Current on hand</dt><dd>{fmt(current)}</dd></div>
                    <div><dt>After receipt</dt><dd className="inv-docket-strong">{fmt(current + total)}</dd></div>
                </dl>
                {err && <p className="login-err inv-docket-err">{err}</p>}
                <div className="inv-docket-actions">
                    <button type="submit" form="inv-receive-form" className="btn-primary" disabled={busy || total <= 0}>
                        {busy ? 'Recording…' : 'Record receipt'}
                    </button>
                </div>
            </aside>
        </div>
    );
}

// -- Dispatch --------------------------------------------------------------

function DispatchView({ inventory, canMove, onDone, onGoto }) {
    const { materials, locations, balances, createMovement, reload, syncBusLocations } = inventory;
    const buOptions = useBuOptions();
    const activeMaterials = materials.filter((m) => m.active);
    const activeLocations = locations.filter((l) => l.active);
    const stores = activeLocations.filter((l) => l.kind === 'store');
    const buLabLocations = activeLocations.filter((l) => l.kind === 'business_unit' || l.kind === 'lab');
    const otherLocations = activeLocations.filter(
        (l) => l.kind !== 'store' && l.kind !== 'business_unit' && l.kind !== 'lab'
    );
    const balMap = useBalanceMap(balances);

    const [materialId, setMaterialId] = useState('');
    const [fromLocationId, setFromLocationId] = useState('');
    const [toLocationId, setToLocationId] = useState('');
    const [qty, setQty] = useState('');
    const [reference, setReference] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    const material = activeMaterials.find((m) => m.id === materialId) || null;

    useEffect(() => {
        if (!buOptions.options.length) return;
        syncBusLocations(buOptions.options);
    }, [syncBusLocations, buOptions.options]);

    useEffect(() => {
        if (fromLocationId) return;
        if (stores.length) setFromLocationId(stores[0].id);
        else if (buLabLocations.length) setFromLocationId(buLabLocations[0].id);
        else if (activeLocations.length) setFromLocationId(activeLocations[0].id);
    }, [stores, buLabLocations, activeLocations, fromLocationId]);

    useEffect(() => {
        if (toLocationId && toLocationId !== ALL_BUS_DEST && toLocationId === fromLocationId) {
            setToLocationId('');
        }
    }, [fromLocationId, toLocationId]);

    const available = materialId && fromLocationId ? balMap.get(balanceKey(materialId, fromLocationId)) || 0 : 0;
    const qtyNum = Number(qty) || 0;
    const buLabDestinations = activeLocations.filter(
        (l) => l.id !== fromLocationId && (l.kind === 'business_unit' || l.kind === 'lab')
    );
    const otherDestinations = activeLocations.filter(
        (l) => l.id !== fromLocationId && l.kind !== 'business_unit' && l.kind !== 'lab'
    );
    const isAllBus = toLocationId === ALL_BUS_DEST;
    const allBuEstimate = Math.max(buLabDestinations.length, buOptions.options.length);
    const destCount = isAllBus ? allBuEstimate : 1;
    const totalDispatchQty = qtyNum * destCount;
    const remaining = available - totalDispatchQty;
    const overdraw = totalDispatchQty > available;
    const unit = material ? material.base_unit : 'units';
    const source = activeLocations.find((l) => l.id === fromLocationId) || null;
    const dest = activeLocations.find((l) => l.id === toLocationId) || null;

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!materialId) return setErr('Select a material.');
        if (!fromLocationId) return setErr('Select a source.');
        if (!toLocationId) return setErr('Select a destination.');
        if (!isAllBus && fromLocationId === toLocationId) return setErr('Source and destination must differ.');
        if (!(qtyNum > 0)) return setErr('Enter a quantity.');
        if (isAllBus && allBuEstimate === 0) {
            return setErr('No business units or labs available. Sync client locations or add destinations in Catalog.');
        }
        setBusy(true);
        try {
            if (isAllBus) {
                const result = await createMovement({
                    kind: 'dispatch',
                    material_id: materialId,
                    from_location_id: fromLocationId,
                    to_all_bus: true,
                    qty_base: qtyNum,
                    reference: reference || undefined,
                    note: note || undefined
                });
                await reload();
                const n = result.destinations || (result.movements && result.movements.length) || 0;
                onDone(
                    `Dispatched ${fmt(qtyNum)} ${unit} of ${material ? material.name : ''} to ${fmt(n)} BUs/labs (${fmt(qtyNum * n)} total).`
                );
            } else {
                await createMovement({
                    kind: 'dispatch',
                    material_id: materialId,
                    from_location_id: fromLocationId,
                    to_location_id: toLocationId,
                    qty_base: qtyNum,
                    reference: reference || undefined,
                    note: note || undefined
                });
                await reload();
                onDone(`Dispatched ${fmt(qtyNum)} ${unit} of ${material ? material.name : ''} to ${dest ? dest.name : ''}.`);
            }
            setQty('');
            setReference('');
            setNote('');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    if (!canMove) return <ReadOnlyNotice />;
    if (!activeMaterials.length) {
        return (
            <EmptyState
                icon="out"
                title="Add materials first"
                action={
                    <button type="button" className="btn-primary" onClick={() => onGoto('catalog')}>
                        Go to Catalog
                    </button>
                }
            >
                Create a material catalog before recording dispatches or BU-to-BU transfers.
            </EmptyState>
        );
    }
    if (!activeLocations.length && buOptions.options.length === 0) {
        return (
            <EmptyState
                icon="out"
                title="Need locations"
                action={
                    <button type="button" className="btn-primary" onClick={() => onGoto('catalog')}>
                        Go to Catalog
                    </button>
                }
            >
                Add store, business unit, or lab locations before dispatching stock.
            </EmptyState>
        );
    }

    return (
        <div className="inv-form-layout">
            <section className="inv-panel">
                <SectionHead
                    title="Dispatch or transfer stock"
                    caption="Move stock out of a store, or between business units in a shortage"
                />
                <form id="inv-dispatch-form" className="inv-form" onSubmit={onSubmit}>
                    <FormStep n="01" title="Route" hint="Source and destination must differ">
                        <label className="inv-field">
                            <span>Material</span>
                            <select value={materialId} onChange={(e) => setMaterialId(e.target.value)} required>
                                <option value="">— select —</option>
                                {activeMaterials.map((m) => (
                                    <option key={m.id} value={m.id}>{m.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="inv-field">
                            <span>From</span>
                            <select value={fromLocationId} onChange={(e) => setFromLocationId(e.target.value)} required>
                                <option value="">— select —</option>
                                {stores.length > 0 && (
                                    <optgroup label="Stores & warehouses">
                                        {stores.map((l) => (
                                            <option key={l.id} value={l.id}>{l.name}</option>
                                        ))}
                                    </optgroup>
                                )}
                                {buLabLocations.length > 0 && (
                                    <optgroup label="Business units & labs">
                                        {buLabLocations.map((l) => (
                                            <option key={l.id} value={l.id}>
                                                {l.name}{l.kind === 'lab' ? ' (lab)' : ''}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {otherLocations.length > 0 && (
                                    <optgroup label="Other locations">
                                        {otherLocations.map((l) => (
                                            <option key={l.id} value={l.id}>{l.name}</option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                        </label>
                        <label className="inv-field">
                            <span>To</span>
                            <select value={toLocationId} onChange={(e) => setToLocationId(e.target.value)} required>
                                <option value="">— select —</option>
                                {(allBuEstimate > 0 || buOptions.options.length > 0) && (
                                    <option value={ALL_BUS_DEST}>
                                        All BUs &amp; labs
                                        {allBuEstimate > 0 ? ` (${allBuEstimate})` : ''}
                                    </option>
                                )}
                                {buLabDestinations.length > 0 && (
                                    <optgroup label="Business units & labs">
                                        {buLabDestinations.map((l) => (
                                            <option key={l.id} value={l.id}>
                                                {l.name}{l.kind === 'lab' ? ' (lab)' : ''}
                                            </option>
                                        ))}
                                    </optgroup>
                                )}
                                {otherDestinations.length > 0 && (
                                    <optgroup label="Other locations">
                                        {otherDestinations.map((l) => (
                                            <option key={l.id} value={l.id}>{l.name}</option>
                                        ))}
                                    </optgroup>
                                )}
                            </select>
                        </label>
                    </FormStep>

                    <FormStep
                        n="02"
                        title="How much"
                        hint={isAllBus && destCount > 1 ? `Per destination · ${fmt(destCount)} sites` : `Counted in ${unit}`}
                    >
                        <label className="inv-field">
                            <span>Quantity ({unit})</span>
                            <input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} required />
                        </label>
                    </FormStep>

                    <FormStep n="03" title="Paperwork" hint="Optional, but useful in the audit trail">
                        <label className="inv-field">
                            <span>Reference</span>
                            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
                        </label>
                        <label className="inv-field">
                            <span>Note</span>
                            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                        </label>
                    </FormStep>
                </form>
            </section>

            <aside className={`inv-docket${overdraw ? ' is-error' : ''}`}>
                <p className="inv-docket-head">Source stock</p>
                <div className="inv-docket-big">
                    {fmt(available)}
                    <span className="inv-docket-unit">on hand</span>
                </div>
                <dl className="inv-docket-dl">
                    <div><dt>Material</dt><dd>{material ? material.name : '—'}</dd></div>
                    <div><dt>From</dt><dd>{source ? source.name : '—'}</dd></div>
                    <div>
                        <dt>To</dt>
                        <dd>{isAllBus ? `All BUs & labs (${fmt(destCount)})` : dest ? dest.name : '—'}</dd>
                    </div>
                    {qtyNum > 0 && (
                        <>
                            <div>
                                <dt>Dispatching</dt>
                                <dd>
                                    −{fmt(totalDispatchQty)}
                                    {isAllBus && destCount > 1 ? ` (${fmt(qtyNum)} each)` : ''}
                                </dd>
                            </div>
                            <div>
                                <dt>Remaining</dt>
                                <dd className={overdraw ? 'inv-docket-danger' : 'inv-docket-strong'}>
                                    {overdraw ? 'Insufficient' : fmt(Math.max(remaining, 0))}
                                </dd>
                            </div>
                        </>
                    )}
                </dl>
                {overdraw && (
                    <p className="inv-docket-note">
                        Not enough stock at the source for this quantity
                        {isAllBus && destCount > 1 ? ` across ${fmt(destCount)} destinations` : ''}.
                    </p>
                )}
                {err && <p className="login-err inv-docket-err">{err}</p>}
                <div className="inv-docket-actions">
                    <button
                        type="submit"
                        form="inv-dispatch-form"
                        className="btn-primary"
                        disabled={busy || qtyNum <= 0 || overdraw || (isAllBus && allBuEstimate === 0)}
                    >
                        {busy ? 'Dispatching…' : isAllBus ? 'Dispatch to all BUs/labs' : 'Record dispatch'}
                    </button>
                </div>
            </aside>
        </div>
    );
}

// -- Ledger ----------------------------------------------------------------

function LedgerView({ inventory, canMove, onDone }) {
    const { materials, fetchMovements, voidMovement, reload } = inventory;
    const [rows, setRows] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState(null);
    const [filterMaterial, setFilterMaterial] = useState('');
    const [filterKind, setFilterKind] = useState('');

    const load = useCallback(
        async (reset) => {
            setLoading(true);
            setErr(null);
            try {
                const params = { limit: 50 };
                if (filterMaterial) params.material_id = filterMaterial;
                if (filterKind) params.kind = filterKind;
                if (!reset && cursor) params.before_id = cursor;
                const j = await fetchMovements(params);
                const next = j.movements || [];
                setRows((prev) => (reset ? next : [...prev, ...next]));
                setCursor(j.next_cursor || null);
            } catch (e) {
                setErr(String(e.message || e));
            } finally {
                setLoading(false);
            }
        },
        [fetchMovements, filterMaterial, filterKind, cursor]
    );

    useEffect(() => {
        setCursor(null);
        load(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filterMaterial, filterKind]);

    async function onVoid(row) {
        if (!window.confirm(`Void this ${row.kind}? It stays in history but stops affecting balances.`)) return;
        try {
            await voidMovement(row.id);
            await reload();
            await load(true);
            onDone('Movement voided.');
        } catch (e) {
            if (String(e.message || '').toLowerCase().includes('on hand')) {
                if (window.confirm(`${e.message}\n\nForce the void anyway (may drive a location negative)?`)) {
                    try {
                        await voidMovement(row.id, { allow_negative: true });
                        await reload();
                        await load(true);
                        onDone('Movement voided (forced).');
                        return;
                    } catch (e2) {
                        window.alert(String(e2.message || e2));
                        return;
                    }
                }
                return;
            }
            window.alert(String(e.message || e));
        }
    }

    return (
        <section className="inv-panel">
            <SectionHead title="Movement ledger" caption="Append-only. Voided rows stay in history but stop counting.">
                <select
                    className="inv-search"
                    value={filterMaterial}
                    onChange={(e) => setFilterMaterial(e.target.value)}
                    aria-label="Filter by material"
                >
                    <option value="">All materials</option>
                    {materials.map((m) => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                    ))}
                </select>
                <select
                    className="inv-search"
                    value={filterKind}
                    onChange={(e) => setFilterKind(e.target.value)}
                    aria-label="Filter by type"
                >
                    <option value="">All types</option>
                    <option value="receipt">Receipt</option>
                    <option value="dispatch">Dispatch</option>
                    <option value="adjustment">Adjustment</option>
                </select>
            </SectionHead>

            {err && <div className="results-error nexus-card">{err}</div>}

            <div className="inv-table-wrap">
                <table className="inv-table">
                    <thead>
                        <tr>
                            <th>When</th>
                            <th>Type</th>
                            <th>Material</th>
                            <th>Movement</th>
                            <th className="num">Qty</th>
                            <th>Details</th>
                            {canMove && <th />}
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r) => {
                            const when = new Date(r.occurred_at);
                            return (
                                <tr key={r.id} className={r.voided_at ? 'inv-voided' : ''}>
                                    <td className="inv-when">
                                        <span className="inv-when-date">{when.toLocaleDateString()}</span>
                                        <span className="inv-when-time">
                                            {when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </td>
                                    <td><span className={`inv-kbadge inv-k-${r.kind}`}>{r.kind}</span></td>
                                    <td className="inv-mat-cell">{r.material_name}</td>
                                    <td className="inv-route">
                                        {r.from_location_name || '—'}
                                        <span className="inv-arrow">→</span>
                                        {r.to_location_name || '—'}
                                    </td>
                                    <td className="num inv-qty">
                                        {fmt(r.qty_base)}<span className="inv-unit">{r.base_unit}</span>
                                    </td>
                                    <td className="muted small inv-details">
                                        {r.vendor && <div>Vendor: {r.vendor}</div>}
                                        {r.reference && <div>Ref: {r.reference}</div>}
                                        {r.note && <div>{r.note}</div>}
                                        {r.voided_at && <span className="inv-void-tag">voided</span>}
                                        {!r.vendor && !r.reference && !r.note && !r.voided_at && (
                                            <span className="inv-dash">·</span>
                                        )}
                                    </td>
                                    {canMove && (
                                        <td className="inv-row-actions">
                                            {!r.voided_at && (
                                                <button type="button" className="chip chip-tool" onClick={() => onVoid(r)}>
                                                    Void
                                                </button>
                                            )}
                                        </td>
                                    )}
                                </tr>
                            );
                        })}
                        {!rows.length && !loading && (
                            <tr>
                                <td colSpan={canMove ? 7 : 6}>
                                    <EmptyState icon="list" title="No movements yet">
                                        Recorded receipts and dispatches will appear here.
                                    </EmptyState>
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {cursor && (
                <div className="inv-loadmore">
                    <button type="button" className="chip chip-tool" disabled={loading} onClick={() => load(false)}>
                        {loading ? 'Loading…' : 'Load more'}
                    </button>
                </div>
            )}
        </section>
    );
}

// -- Catalog (admin) -------------------------------------------------------

function CatalogView({ inventory, onDone, seeding, onSeed }) {
    const hasAny = inventory.materials.length > 0 || inventory.locations.length > 0;
    return (
        <>
            {!hasAny && (
                <div className="inv-banner inv-banner-soft">
                    <Icon name="box" />
                    <span>
                        Empty catalog.{' '}
                        <button type="button" className="inv-linkbtn" onClick={onSeed} disabled={seeding}>
                            {seeding ? 'setting up…' : 'Create the starter catalog'}
                        </button>{' '}
                        to add 12 standard materials and a Central Store, or add items manually below.
                    </span>
                </div>
            )}
            <div className="inv-catalog">
                <MaterialsPanel inventory={inventory} onDone={onDone} />
                <LocationsPanel inventory={inventory} onDone={onDone} />
            </div>
        </>
    );
}

function MaterialsPanel({ inventory, onDone }) {
    const { materials, createMaterial, updateMaterial, reload } = inventory;
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [baseUnit, setBaseUnit] = useState('unit');
    const [packSize, setPackSize] = useState('1');
    const [reorder, setReorder] = useState('0');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!name.trim()) return setErr('Name is required.');
        setBusy(true);
        try {
            await createMaterial({
                name: name.trim(),
                base_unit: baseUnit.trim() || 'unit',
                default_pack_size: Number(packSize) || 1,
                reorder_level: Number(reorder) || 0
            });
            await reload();
            onDone(`Added material “${name.trim()}”.`);
            setName('');
            setBaseUnit('unit');
            setPackSize('1');
            setReorder('0');
            setOpen(false);
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    async function toggleActive(m) {
        try {
            await updateMaterial(m.id, { active: !m.active });
            await reload();
        } catch (e) {
            window.alert(String(e.message || e));
        }
    }

    async function editReorder(m) {
        const next = window.prompt(`Reorder level for ${m.name} (warn when store stock drops below this):`, String(m.reorder_level));
        if (next == null) return;
        const val = Number(next);
        if (!Number.isFinite(val) || val < 0) return window.alert('Enter a number ≥ 0.');
        try {
            await updateMaterial(m.id, { reorder_level: val });
            await reload();
            onDone(`Updated reorder level for ${m.name}.`);
        } catch (e) {
            window.alert(String(e.message || e));
        }
    }

    return (
        <section className="inv-panel">
            <SectionHead title="Materials" caption={`${fmt(materials.length)} in catalog`}>
                <button type="button" className="btn-primary btn-sm" onClick={() => setOpen((v) => !v)}>
                    {open ? 'Cancel' : '+ New material'}
                </button>
            </SectionHead>
            {open && (
                <form className="inv-inline-form" onSubmit={onSubmit}>
                    <div className="inv-fs-grid">
                        <label className="inv-field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
                        <label className="inv-field"><span>Base unit</span><input value={baseUnit} onChange={(e) => setBaseUnit(e.target.value)} /></label>
                        <label className="inv-field"><span>Default pack size</span><input type="number" min="1" value={packSize} onChange={(e) => setPackSize(e.target.value)} /></label>
                        <label className="inv-field"><span>Reorder level</span><input type="number" min="0" value={reorder} onChange={(e) => setReorder(e.target.value)} /></label>
                    </div>
                    {err && <p className="login-err">{err}</p>}
                    <div className="form-actions">
                        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add material'}</button>
                    </div>
                </form>
            )}
            {materials.length ? (
                <div className="inv-table-wrap">
                    <table className="inv-table">
                        <thead>
                            <tr><th>Name</th><th>Unit</th><th className="num">Reorder</th><th /></tr>
                        </thead>
                        <tbody>
                            {materials.map((m) => (
                                <tr key={m.id} className={m.active ? '' : 'inv-voided'}>
                                    <td className="inv-mat-cell">{m.name}</td>
                                    <td className="muted small">{m.base_unit}</td>
                                    <td className="num">{m.reorder_level ? fmt(m.reorder_level) : '·'}</td>
                                    <td className="inv-row-actions">
                                        <button type="button" className="chip chip-tool" onClick={() => editReorder(m)}>Reorder</button>
                                        <button type="button" className="chip chip-tool" onClick={() => toggleActive(m)}>
                                            {m.active ? 'Disable' : 'Enable'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className="muted small inv-panel-empty">No materials yet.</p>
            )}
        </section>
    );
}

function LocationsPanel({ inventory, onDone }) {
    const { locations, createLocation, updateLocation, reload, fetchLabs } = inventory;
    const buOptions = useBuOptions();
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [kind, setKind] = useState('business_unit');
    const [buCode, setBuCode] = useState('');
    const [clientCode, setClientCode] = useState('');
    const [labs, setLabs] = useState([]);
    const [labsLoaded, setLabsLoaded] = useState(false);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    useEffect(() => {
        if (kind !== 'lab' || labsLoaded) return;
        let cancelled = false;
        fetchLabs()
            .then((r) => { if (!cancelled) { setLabs(r); setLabsLoaded(true); } })
            .catch(() => setLabsLoaded(true));
        return () => { cancelled = true; };
    }, [kind, labsLoaded, fetchLabs]);

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!name.trim()) return setErr('Name is required.');
        setBusy(true);
        try {
            await createLocation({
                name: name.trim(),
                kind,
                bu_code: kind === 'business_unit' ? buCode || undefined : undefined,
                client_code: kind === 'lab' ? clientCode || undefined : undefined
            });
            await reload();
            onDone(`Added location “${name.trim()}”.`);
            setName('');
            setBuCode('');
            setClientCode('');
            setOpen(false);
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    async function toggleActive(l) {
        try {
            await updateLocation(l.id, { active: !l.active });
            await reload();
        } catch (e) {
            window.alert(String(e.message || e));
        }
    }

    return (
        <section className="inv-panel">
            <SectionHead title="Locations" caption={`${fmt(locations.length)} stores, BUs and labs`}>
                <button type="button" className="btn-primary btn-sm" onClick={() => setOpen((v) => !v)}>
                    {open ? 'Cancel' : '+ New location'}
                </button>
            </SectionHead>
            {open && (
                <form className="inv-inline-form" onSubmit={onSubmit}>
                    <div className="inv-fs-grid">
                        <label className="inv-field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} required autoFocus /></label>
                        <label className="inv-field">
                            <span>Kind</span>
                            <select value={kind} onChange={(e) => setKind(e.target.value)}>
                                <option value="store">Central store</option>
                                <option value="business_unit">Business unit</option>
                                <option value="lab">Lab (MCC code)</option>
                            </select>
                        </label>
                        {kind === 'business_unit' && (
                            <label className="inv-field">
                                <span>Business unit</span>
                                <select
                                    value={buCode}
                                    onChange={(e) => {
                                        const opt = buOptions.options.find((o) => o.id === e.target.value);
                                        setBuCode(e.target.value);
                                        if (opt && !name.trim()) setName(opt.label);
                                    }}
                                >
                                    <option value="">— optional link —</option>
                                    {buOptions.options.map((o) => (
                                        <option key={o.id} value={o.id}>{o.label}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                        {kind === 'lab' && (
                            <label className="inv-field">
                                <span>Lab / MCC code</span>
                                <select
                                    value={clientCode}
                                    onChange={(e) => {
                                        const lab = labs.find((l) => l.code === e.target.value);
                                        setClientCode(e.target.value);
                                        if (lab && !name.trim()) setName(lab.name || lab.code);
                                    }}
                                >
                                    <option value="">{labsLoaded ? '— optional link —' : 'Loading…'}</option>
                                    {labs.map((l) => (
                                        <option key={l.code} value={l.code}>{l.code} · {l.name || 'Unnamed'}</option>
                                    ))}
                                </select>
                            </label>
                        )}
                    </div>
                    {err && <p className="login-err">{err}</p>}
                    <div className="form-actions">
                        <button type="submit" className="btn-primary" disabled={busy}>{busy ? 'Adding…' : 'Add location'}</button>
                    </div>
                </form>
            )}
            {locations.length ? (
                <div className="inv-table-wrap">
                    <table className="inv-table">
                        <thead>
                            <tr><th>Name</th><th>Kind</th><th>Link</th><th /></tr>
                        </thead>
                        <tbody>
                            {locations.map((l) => (
                                <tr key={l.id} className={l.active ? '' : 'inv-voided'}>
                                    <td className="inv-mat-cell">{l.name}</td>
                                    <td>
                                        <span className={`inv-badge inv-badge-${kindDot(l.kind)}`}>
                                            {kindLabel(l.kind)}
                                        </span>
                                    </td>
                                    <td className="muted small">{l.bu_code || l.client_code || '·'}</td>
                                    <td className="inv-row-actions">
                                        {l.kind !== 'store' && (
                                            <button type="button" className="chip chip-tool" onClick={() => toggleActive(l)}>
                                                {l.active ? 'Disable' : 'Enable'}
                                            </button>
                                        )}
                                    </td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className="muted small inv-panel-empty">No locations yet.</p>
            )}
        </section>
    );
}

function ReadOnlyNotice() {
    return (
        <EmptyState icon="warn" title="Read-only access">
            You can view inventory but not record movements. Ask an admin or operator to make changes.
        </EmptyState>
    );
}
