import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiUrl } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';
import { useBuOptions } from '../hooks/useBuOptions.js';
import { useInventory } from '../hooks/useInventory.js';

const ALL_BUS_DEST = '__all_bus__';

const CATALOG_ROLES = new Set(['super_admin', 'admin']);
const MOVER_ROLES = new Set(['super_admin', 'admin', 'operator']);

// Business-unit columns shown by default in the stock matrix (stores are
// always shown). Chosen so the table fits a laptop without a scrollbar.
const MAX_BU_COLUMNS = 6;

const VIEWS = [
    { id: 'stock', label: 'Stock', icon: 'grid', caption: 'On-hand matrix' },
    { id: 'receive', label: 'Receive', icon: 'in', caption: 'Vendor intake' },
    { id: 'dispatch', label: 'Dispatch', icon: 'out', caption: 'Ship & transfer' },
    { id: 'ledger', label: 'Ledger', icon: 'list', caption: 'Movement history' },
    { id: 'vendors', label: 'Vendors', icon: 'truck', caption: 'Suppliers & GST' },
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
        case 'truck':
            return (<svg {...p}><path d="M3 6h11v9H3z" /><path d="M14 9h4l3 3v3h-7z" /><circle cx="7" cy="18" r="1.6" /><circle cx="17.5" cy="18" r="1.6" /></svg>);
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

function todayDateInput() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Local calendar date → ISO; noon avoids timezone day-shift. */
function dateInputToIso(dateStr) {
    if (!dateStr) return undefined;
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return undefined;
    return d.toISOString();
}

/**
 * Searchable location picker with inline “+ Add new …” create.
 * `groups` = [{ label, items }]; `specialOptions` = [{ value, label }] (e.g. All BUs).
 */
function LocationCombobox({
    value,
    onChange,
    locations = [],
    groups = null,
    specialOptions = [],
    placeholder = '— select —',
    required = false,
    allowCreate = true,
    defaultKind = 'business_unit',
    createLocation,
    reload,
    disabled = false
}) {
    const rootRef = useRef(null);
    const inputRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState('');
    const [creating, setCreating] = useState(false);
    const [createErr, setCreateErr] = useState(null);

    const selectedSpecial = specialOptions.find((o) => o.value === value) || null;
    const selectedLoc = locations.find((l) => l.id === value) || null;
    const displayLabel = selectedSpecial
        ? selectedSpecial.label
        : selectedLoc
            ? selectedLoc.name
            : '';

    const q = query.trim().toLowerCase();

    const filteredSpecial = specialOptions.filter(
        (o) => !q || o.label.toLowerCase().includes(q)
    );

    const filteredGroups = useMemo(() => {
        const source = groups
            ? groups
            : locations.length
                ? [{ label: null, items: locations }]
                : [];
        return source
            .map((g) => ({
                label: g.label,
                items: (g.items || []).filter((l) => !q || l.name.toLowerCase().includes(q))
            }))
            .filter((g) => g.items.length > 0);
    }, [groups, locations, q]);

    const flatMatches = filteredGroups.flatMap((g) => g.items);
    const exactNameMatch = [...locations, ...specialOptions.map((o) => ({ name: o.label }))].some(
        (l) => l.name && l.name.trim().toLowerCase() === q
    );
    const canAdd =
        allowCreate &&
        Boolean(createLocation) &&
        q.length > 0 &&
        !exactNameMatch &&
        !creating;

    useEffect(() => {
        if (!open) return undefined;
        function onDoc(e) {
            if (rootRef.current && !rootRef.current.contains(e.target)) {
                setOpen(false);
                setQuery('');
                setCreateErr(null);
            }
        }
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    function openMenu() {
        if (disabled) return;
        setOpen(true);
        setQuery('');
        setCreateErr(null);
        requestAnimationFrame(() => {
            if (inputRef.current) inputRef.current.focus();
        });
    }

    function pick(next) {
        onChange(next);
        setOpen(false);
        setQuery('');
        setCreateErr(null);
    }

    async function onAddNew() {
        const name = query.trim();
        if (!name || !createLocation) return;
        setCreating(true);
        setCreateErr(null);
        try {
            const res = await createLocation({ name, kind: defaultKind });
            const loc = res && res.location ? res.location : res;
            if (reload) await reload();
            if (loc && loc.id) onChange(loc.id);
            setOpen(false);
            setQuery('');
        } catch (e) {
            setCreateErr(String(e.message || e));
        } finally {
            setCreating(false);
        }
    }

    const showEmpty = filteredSpecial.length === 0 && flatMatches.length === 0 && !canAdd;

    return (
        <div className={`inv-combo${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`} ref={rootRef}>
            {open ? (
                <input
                    ref={inputRef}
                    className="inv-combo-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                            setOpen(false);
                            setQuery('');
                        } else if (e.key === 'Enter' && canAdd && flatMatches.length === 0 && filteredSpecial.length === 0) {
                            e.preventDefault();
                            onAddNew();
                        }
                    }}
                    placeholder={displayLabel || 'Type to search…'}
                    disabled={disabled || creating}
                    aria-autocomplete="list"
                    aria-expanded="true"
                    role="combobox"
                    autoComplete="off"
                />
            ) : (
                <button
                    type="button"
                    className={`inv-combo-trigger${value ? '' : ' is-placeholder'}`}
                    onClick={openMenu}
                    disabled={disabled}
                    aria-haspopup="listbox"
                    aria-expanded="false"
                >
                    {displayLabel || placeholder}
                </button>
            )}
            {/* Keep a native required check for form submit when closed empty */}
            {required && (
                <input
                    className="inv-combo-required"
                    tabIndex={-1}
                    value={value || ''}
                    onChange={() => {}}
                    required
                    aria-hidden="true"
                />
            )}
            {open && (
                <div className="inv-combo-menu" role="listbox">
                    {filteredSpecial.map((o) => (
                        <button
                            key={o.value}
                            type="button"
                            className={`inv-combo-option${o.value === value ? ' is-active' : ''}`}
                            role="option"
                            aria-selected={o.value === value}
                            onClick={() => pick(o.value)}
                        >
                            {o.label}
                        </button>
                    ))}
                    {filteredGroups.map((g) => (
                        <div key={g.label || '_'} className="inv-combo-group">
                            {g.label && <div className="inv-combo-group-label">{g.label}</div>}
                            {g.items.map((l) => (
                                <button
                                    key={l.id}
                                    type="button"
                                    className={`inv-combo-option${l.id === value ? ' is-active' : ''}`}
                                    role="option"
                                    aria-selected={l.id === value}
                                    onClick={() => pick(l.id)}
                                >
                                    <span>{l.name}</span>
                                    {l.kind === 'lab' && <span className="inv-combo-kind">lab</span>}
                                </button>
                            ))}
                        </div>
                    ))}
                    {canAdd && (
                        <button
                            type="button"
                            className="inv-combo-option inv-combo-add"
                            onClick={onAddNew}
                            disabled={creating}
                        >
                            <span>+ Add new &ldquo;{query.trim()}&rdquo;</span>
                            <span className="inv-combo-new-badge">{creating ? '…' : 'NEW'}</span>
                        </button>
                    )}
                    {showEmpty && (
                        <div className="inv-combo-empty">No locations match</div>
                    )}
                    {createErr && <div className="inv-combo-err">{createErr}</div>}
                </div>
            )}
        </div>
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
            <header className={`inv-masthead${view === 'stock' ? '' : ' inv-masthead--compact'}`}>
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
                    {/* The glance strip belongs to the overview. On a working
                        view (receive, dispatch, ledger…) it only pushes the
                        first field below the fold — a whole screen on a phone. */}
                    {view === 'stock' && (
                        <FiguresStrip
                            summary={inventory.summary}
                            locations={inventory.locations}
                            onLowStock={() => goto('stock')}
                        />
                    )}

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
                        {view === 'vendors' && (
                            <VendorsView inventory={inventory} canManageCatalog={canManageCatalog} onDone={showFlash} />
                        )}
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
                The starter catalog adds the standard materials list (letter heads, envelopes, vials,
                tubes, consumables…) and a Central Store. You can edit or add more anytime.
            </p>
        </section>
    );
}

// -- Figures ---------------------------------------------------------------

function FiguresStrip({ summary, locations, onLowStock }) {
    if (!summary) return null;
    const low = summary.low_stock ? summary.low_stock.length : 0;
    const activeLocs = Array.isArray(locations) ? locations.filter((l) => l.active) : [];
    const storeCount = activeLocs.filter((l) => l.kind === 'store').length;
    const locationCap =
        activeLocs.length > 0
            ? `${fmt(storeCount)} ${storeCount === 1 ? 'store' : 'stores'}, ${fmt(activeLocs.length - storeCount)} BUs and labs`
            : 'stores, BUs and labs';
    const voided = typeof summary.movements_voided === 'number' ? summary.movements_voided : null;
    const ledgerCap =
        voided === null
            ? 'receipts and dispatches'
            : voided === 0
              ? 'none voided'
              : `${fmt(voided)} voided, excluded from stock`;
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
                <span className="inv-figure-cap">{locationCap}</span>
            </div>
            <div className="inv-figure">
                <span className="inv-figure-num">{fmt(summary.vendors)}</span>
                <span className="inv-figure-label">Vendors</span>
                <span className="inv-figure-cap">onboarded suppliers</span>
            </div>
            <div className="inv-figure">
                <span className="inv-figure-num">{fmt(summary.movements)}</span>
                <span className="inv-figure-label">Ledger entries</span>
                <span className="inv-figure-cap">{ledgerCap}</span>
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
    const [showAllLocations, setShowAllLocations] = useState(false);

    const storeIds = useMemo(
        () => new Set(activeLocations.filter((l) => l.kind === 'store').map((l) => l.id)),
        [activeLocations]
    );

    // Columns: stores first, then the busiest business units. The full set is
    // 80-odd columns wide, which is a horizontal scroll nobody reads; the
    // default view keeps the two stores plus the BUs actually holding stock,
    // and "Show all" is one click away. Row totals still sum every location.
    const shownLocations = useMemo(() => {
        const stores = activeLocations.filter((l) => l.kind === 'store');
        const others = activeLocations.filter((l) => l.kind !== 'store');
        if (showAllLocations) return [...stores, ...others];
        const colTotalAll = (locId) =>
            activeMaterials.reduce((s, m) => s + Math.abs(balMap.get(balanceKey(m.id, locId)) || 0), 0);
        const ranked = others
            .map((l) => ({ l, t: colTotalAll(l.id) }))
            .filter((x) => x.t > 0)
            .sort((a, b) => b.t - a.t)
            .slice(0, MAX_BU_COLUMNS)
            .map((x) => x.l);
        return [...stores, ...ranked];
    }, [activeLocations, activeMaterials, balMap, showAllLocations]);
    const hiddenLocationCount = activeLocations.length - shownLocations.length;

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
                caption={
                    hiddenLocationCount > 0
                        ? `${fmt(rows.length)} of ${fmt(activeMaterials.length)} materials · stores first, then the ${fmt(shownLocations.length - storeIds.size)} busiest of ${fmt(activeLocations.length - storeIds.size)} business units and labs`
                        : `${fmt(rows.length)} of ${fmt(activeMaterials.length)} materials across ${fmt(activeLocations.length)} locations`
                }
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
                {(hiddenLocationCount > 0 || showAllLocations) && (
                    <button
                        type="button"
                        className="chip chip-tool"
                        aria-pressed={showAllLocations ? 'true' : 'false'}
                        onClick={() => setShowAllLocations((v) => !v)}
                    >
                        {showAllLocations ? 'Busiest only' : `Show all ${fmt(activeLocations.length)} locations`}
                    </button>
                )}
                <button type="button" className="chip chip-tool" onClick={() => onGoto('receive')}>
                    Receive
                </button>
                <button type="button" className="btn-primary btn-sm" onClick={() => onGoto('dispatch')}>
                    <Icon name="out" />
                    Dispatch
                </button>
            </SectionHead>

            <div className="inv-table-wrap">
                <table className="inv-matrix">
                    <thead>
                        <tr>
                            <th className="sticky-col">Material</th>
                            {shownLocations.map((l) => (
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
                                {shownLocations.map((l) => {
                                    const val = balMap.get(balanceKey(m.id, l.id)) || 0;
                                    const low = storeIds.has(l.id) && m.reorder_level > 0 && val < m.reorder_level;
                                    return (
                                        <td
                                            key={l.id}
                                            className={`num${val === 0 ? ' inv-zero' : ''}${val < 0 ? ' inv-neg' : ''}${low ? ' inv-low' : ''}`}
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
                                <td colSpan={shownLocations.length + 2} className="muted inv-nomatch">
                                    No materials match “{query}”.
                                </td>
                            </tr>
                        )}
                    </tbody>
                    {rows.length > 0 && (
                        <tfoot>
                            <tr>
                                <td className="sticky-col">Total</td>
                                {shownLocations.map((l) => {
                                    const t = colTotal(l.id);
                                    return (
                                        <td key={l.id} className={`num${t < 0 ? ' inv-neg' : ''}`}>
                                            {fmt(t)}
                                        </td>
                                    );
                                })}
                                <td className="num inv-total-col">{fmt(grandTotal)}</td>
                            </tr>
                        </tfoot>
                    )}
                </table>
            </div>
        </section>
    );
}

// -- Order helpers (shared by Receive & Dispatch) --------------------------

let _lineSeq = 0;
function makeLine(extra = {}) {
    _lineSeq += 1;
    return { key: `ln-${_lineSeq}`, materialId: '', packSize: '', packQty: '', photoUrl: '', uploading: false, ...extra };
}

// A running list of material lines for an order, with add/remove/patch helpers.
function useOrderLines() {
    const [lines, setLines] = useState(() => [makeLine()]);
    const addLine = useCallback(() => setLines((ls) => [...ls, makeLine()]), []);
    const removeLine = useCallback(
        (key) => setLines((ls) => (ls.length > 1 ? ls.filter((l) => l.key !== key) : ls)),
        []
    );
    const updateLine = useCallback(
        (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l))),
        []
    );
    const resetLines = useCallback(() => setLines([makeLine()]), []);
    return { lines, addLine, removeLine, updateLine, resetLines };
}

// Per-line proof photo: tap to pick or capture, shows a thumbnail once uploaded.
function LinePhoto({ url, uploading, onPick, onClear }) {
    const inputRef = useRef(null);
    return (
        <div className="inv-line-photo">
            <input
                ref={inputRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                    const f = e.target.files && e.target.files[0];
                    if (f) onPick(f);
                    e.target.value = '';
                }}
            />
            {url ? (
                <span className="inv-line-thumb">
                    <a href={apiUrl(url)} target="_blank" rel="noreferrer">
                        <img src={apiUrl(url)} alt="proof" />
                    </a>
                    <button type="button" className="inv-line-thumb-x" onClick={onClear} aria-label="Remove photo">×</button>
                </span>
            ) : (
                <button
                    type="button"
                    className="chip chip-tool inv-line-photo-btn"
                    onClick={() => inputRef.current && inputRef.current.click()}
                    disabled={uploading}
                >
                    {uploading ? 'Uploading…' : '+ Photo'}
                </button>
            )}
        </div>
    );
}

// A material <select>; when a vendor is chosen its supplied items lead in their
// own optgroup, the rest follow. Reused by both order forms (dispatch passes no
// vendor, so it just lists everything).
function MaterialSelect({ value, onChange, materials, vendor }) {
    const suppliedIds = vendor ? new Set(vendor.material_ids || []) : null;
    const supplied = suppliedIds ? materials.filter((m) => suppliedIds.has(m.id)) : [];
    const rest = suppliedIds ? materials.filter((m) => !suppliedIds.has(m.id)) : materials;
    return (
        <select value={value} onChange={(e) => onChange(e.target.value)} required>
            <option value="">— select —</option>
            {suppliedIds ? (
                <>
                    {supplied.length > 0 && (
                        <optgroup label={`Supplied by ${vendor.name}`}>
                            {supplied.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </optgroup>
                    )}
                    {rest.length > 0 && (
                        <optgroup label="Other materials">
                            {rest.map((m) => (
                                <option key={m.id} value={m.id}>{m.name}</option>
                            ))}
                        </optgroup>
                    )}
                </>
            ) : (
                materials.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                ))
            )}
        </select>
    );
}

// A number input with a custom, theme-matched up/down stepper. The native
// spinner is hidden in CSS; these buttons clamp to `min` and don't steal focus.
function StepInput({ value, onChange, min = 1, ariaLabel }) {
    const step = (delta) => {
        const cur = value === '' || value == null ? min - 1 : Number(value);
        const base = Number.isFinite(cur) ? cur : min - 1;
        onChange(String(Math.max(min, base + delta)));
    };
    return (
        <span className="inv-step">
            <input
                type="number"
                min={min}
                value={value}
                onChange={(e) => onChange(e.target.value)}
                aria-label={ariaLabel}
            />
            <span className="inv-step-btns" aria-hidden="true">
                <button type="button" tabIndex={-1} className="inv-step-up" onClick={() => step(1)} aria-label="Increase" />
                <button type="button" tabIndex={-1} className="inv-step-down" onClick={() => step(-1)} aria-label="Decrease" />
            </span>
        </span>
    );
}

// -- Receive ---------------------------------------------------------------

// -- Docket + location defaults (shared by Receive and Dispatch) --------------

const LS_RECEIVE_DEST = 'inv.receive.destination';
const LS_DISPATCH_FROM = 'inv.dispatch.source';

function recallLocation(key) {
    try {
        return localStorage.getItem(key) || '';
    } catch {
        return '';
    }
}

function rememberLocation(key, id) {
    try {
        if (id) localStorage.setItem(key, id);
    } catch {
        /* storage unavailable — nothing to remember */
    }
}

/**
 * The store to pre-select: the one used last time, else the one holding the
 * most stock. Alphabetical-first put a satellite office ahead of the central
 * warehouse on every form.
 */
function pickDefaultStore(stores, balMap, materials, key) {
    if (!stores.length) return '';
    const remembered = recallLocation(key);
    if (remembered && stores.some((s) => s.id === remembered)) return remembered;
    let best = stores[0];
    let bestTotal = -Infinity;
    for (const s of stores) {
        // Positive on-hand only: a store that has been overdrawn into large
        // negatives is not "holding the most stock", whatever its magnitude.
        const total = materials.reduce((sum, m) => sum + Math.max(0, balMap.get(balanceKey(m.id, s.id)) || 0), 0);
        if (total > bestTotal) {
            bestTotal = total;
            best = s;
        }
    }
    return best.id;
}

/** `YYYY-MM-DD` from a date input → the viewer's own date format. */
function fmtDateInput(dateStr) {
    if (!dateStr) return '—';
    const d = new Date(`${dateStr}T12:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

const DOCKET_LINE_CAP = 8;

/**
 * The receipt / dispatch docket: what is about to be written to the ledger.
 * Lists the actual lines rather than just counting them, keeps the big
 * number quiet until there is something to record, and on phones repeats
 * the action in a bar that stays reachable while the form scrolls.
 */
function MovementDocket({ formId, heading, sign, total, ready, facts, lines, warn, note, err, disabled, label }) {
    const ref = useRef(null);
    useEffect(() => {
        if (err && ref.current) ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }, [err]);

    const shown = lines.slice(0, DOCKET_LINE_CAP);
    const hidden = lines.length - shown.length;
    const bigClass = `inv-docket-big${ready ? '' : ' is-empty'}`;

    return (
        <aside className={`inv-docket${warn ? ' is-warn' : ''}`} ref={ref}>
            <p className="inv-docket-head">{heading}</p>
            <div className={bigClass}>
                {sign}
                {fmt(total)}
                <span className="inv-docket-unit">units</span>
            </div>
            <dl className="inv-docket-dl">
                {facts.map(([dt, dd, cls]) => (
                    <div key={dt}>
                        <dt>{dt}</dt>
                        <dd className={cls || undefined}>{dd}</dd>
                    </div>
                ))}
            </dl>
            {lines.length > 0 ? (
                <ul className="inv-docket-lines">
                    {shown.map((l) => (
                        <li key={l.key} className={l.warn ? 'is-warn' : ''}>
                            <span className="inv-docket-line-name">{l.name}</span>
                            <span className="inv-docket-line-qty">
                                {fmt(l.qty)}
                                {l.unit && <span className="inv-unit">{l.unit}</span>}
                            </span>
                        </li>
                    ))}
                    {hidden > 0 && <li className="inv-docket-more">+ {fmt(hidden)} more</li>}
                </ul>
            ) : (
                <p className="inv-docket-empty">Nothing added yet — pick a material and a pack count below.</p>
            )}
            {note && <p className="inv-docket-note">{note}</p>}
            {err && <p className="login-err inv-docket-err">{err}</p>}
            <div className="inv-docket-actions">
                <button type="submit" form={formId} className="btn-primary" disabled={disabled}>
                    {label}
                </button>
            </div>
            <div className="inv-docket-bar" aria-hidden={ready ? undefined : 'true'}>
                <span className="inv-docket-bar-total">
                    {sign}
                    {fmt(total)} <span className="inv-unit">units</span>
                </span>
                <button type="submit" form={formId} className="btn-primary" disabled={disabled}>
                    {label}
                </button>
            </div>
        </aside>
    );
}

function ReceiveView({ inventory, canMove, onDone, onGoto }) {
    const { materials, vendors, locations, balances, createMovementsBatch, createLocation, uploadPhoto, reload } = inventory;
    const activeMaterials = materials.filter((m) => m.active);
    const activeVendors = (vendors || []).filter((v) => v.active);
    const activeLocations = locations.filter((l) => l.active);
    const stores = activeLocations.filter((l) => l.kind === 'store');
    const matById = useMemo(() => new Map(activeMaterials.map((m) => [m.id, m])), [activeMaterials]);
    const balMap = useBalanceMap(balances);

    const [vendorId, setVendorId] = useState('');
    const [toLocationId, setToLocationId] = useState('');
    const [occurredOn, setOccurredOn] = useState(todayDateInput);
    const [reference, setReference] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const { lines, addLine, removeLine, updateLine, resetLines } = useOrderLines();

    const vendor = activeVendors.find((v) => v.id === vendorId) || null;

    useEffect(() => {
        if (!toLocationId && stores.length) {
            setToLocationId(pickDefaultStore(stores, balMap, activeMaterials, LS_RECEIVE_DEST));
        }
    }, [stores, toLocationId, balMap, activeMaterials]);

    // Default a line's pack size from its material the moment one is chosen.
    function onPickMaterial(key, materialId) {
        const m = matById.get(materialId);
        updateLine(key, {
            materialId,
            packSize: m ? String(m.default_pack_size || 1) : ''
        });
    }

    async function onPickPhoto(key, file) {
        updateLine(key, { uploading: true });
        try {
            const url = await uploadPhoto(file);
            updateLine(key, { photoUrl: url, uploading: false });
        } catch (e) {
            updateLine(key, { uploading: false });
            window.alert(`Photo upload failed: ${e.message || e}`);
        }
    }

    const validLines = lines.filter((l) => l.materialId && Number(l.packQty) > 0);
    const totalUnits = validLines.reduce((s, l) => s + (Number(l.packSize) || 0) * (Number(l.packQty) || 0), 0);
    const anyUploading = lines.some((l) => l.uploading);

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!toLocationId) return setErr('Select a destination.');
        if (!validLines.length) return setErr('Add at least one material with a pack count.');
        setBusy(true);
        try {
            const result = await createMovementsBatch({
                kind: 'receipt',
                to_location_id: toLocationId,
                vendor_id: vendorId || undefined,
                reference: reference || undefined,
                note: note || undefined,
                occurred_at: dateInputToIso(occurredOn),
                lines: validLines.map((l) => ({
                    material_id: l.materialId,
                    pack_size: Number(l.packSize) || 1,
                    pack_qty: Number(l.packQty),
                    photo_path: l.photoUrl || undefined
                }))
            });
            await reload();
            const n = (result.movements && result.movements.length) || validLines.length;
            rememberLocation(LS_RECEIVE_DEST, toLocationId);
            onDone(`Received ${fmt(totalUnits)} units across ${fmt(n)} material${n === 1 ? '' : 's'}.`);
            resetLines();
            setReference('');
            setNote('');
            setOccurredOn(todayDateInput());
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

    const destination = activeLocations.find((l) => l.id === toLocationId) || null;

    return (
        <div className="inv-form-layout">
            <section className="inv-panel">
                <SectionHead title="Receive from vendor" caption="One vendor, one delivery — add every material on the docket" />
                <form id="inv-receive-form" className="inv-order-form" onSubmit={onSubmit}>
                    <FormStep n="01" title="From whom & where" hint="Applies to every line below">
                        <label className="inv-field">
                            <span>Vendor</span>
                            <select value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                                <option value="">— none —</option>
                                {activeVendors.map((v) => (
                                    <option key={v.id} value={v.id}>{v.name}</option>
                                ))}
                            </select>
                        </label>
                        <label className="inv-field">
                            <span>Destination store</span>
                            <LocationCombobox
                                value={toLocationId}
                                onChange={setToLocationId}
                                locations={activeLocations}
                                required
                                defaultKind="store"
                                createLocation={createLocation}
                                reload={reload}
                            />
                        </label>
                        <label className="inv-field">
                            <span>Date</span>
                            <input
                                type="date"
                                value={occurredOn}
                                onChange={(e) => setOccurredOn(e.target.value)}
                                required
                            />
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

                    <div className="inv-order-lines">
                        <div className="inv-order-lines-head">
                            <span className="inv-fs-n">02</span>
                            <div className="inv-fs-titles">
                                <span className="inv-fs-title">Materials received</span>
                                <span className="inv-fs-hint">Pack size defaults from the catalog — override if the box differs</span>
                            </div>
                        </div>
                        <div className="inv-line-table-wrap">
                            <table className="inv-line-table">
                                <thead>
                                    <tr>
                                        <th className="inv-lt-mat">Material</th>
                                        <th className="inv-lt-num">Pack size</th>
                                        <th className="inv-lt-num">Packs</th>
                                        <th className="inv-lt-num">= Units</th>
                                        <th className="inv-lt-photo">Photo</th>
                                        <th aria-label="Remove" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {lines.map((l) => {
                                        const lineTotal = (Number(l.packSize) || 0) * (Number(l.packQty) || 0);
                                        const m = matById.get(l.materialId);
                                        const unit = m ? m.base_unit : '';
                                        return (
                                            <tr key={l.key}>
                                                <td className="inv-lt-mat" data-label="Material">
                                                    <MaterialSelect
                                                        value={l.materialId}
                                                        onChange={(v) => onPickMaterial(l.key, v)}
                                                        materials={activeMaterials}
                                                        vendor={vendor}
                                                    />
                                                </td>
                                                <td className="inv-lt-num" data-label="Pack size">
                                                    <StepInput
                                                        value={l.packSize}
                                                        onChange={(v) => updateLine(l.key, { packSize: v })}
                                                        ariaLabel="Pack size"
                                                    />
                                                </td>
                                                <td className="inv-lt-num" data-label="Packs">
                                                    <StepInput
                                                        value={l.packQty}
                                                        onChange={(v) => updateLine(l.key, { packQty: v })}
                                                        ariaLabel="Number of packs"
                                                    />
                                                </td>
                                                <td className="inv-lt-num inv-lt-total" data-label="= Units">
                                                    {lineTotal > 0 ? `${fmt(lineTotal)}${unit ? ` ${unit}` : ''}` : '—'}
                                                </td>
                                                <td className="inv-lt-photo" data-label="Photo">
                                                    <LinePhoto
                                                        url={l.photoUrl}
                                                        uploading={l.uploading}
                                                        onPick={(f) => onPickPhoto(l.key, f)}
                                                        onClear={() => updateLine(l.key, { photoUrl: '' })}
                                                    />
                                                </td>
                                                <td className="inv-lt-x" data-label="">
                                                    <button
                                                        type="button"
                                                        className="inv-line-remove"
                                                        onClick={() => removeLine(l.key)}
                                                        disabled={lines.length === 1}
                                                        aria-label="Remove line"
                                                    >
                                                        ×
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <button type="button" className="inv-line-add" onClick={addLine}>
                            + Add material
                        </button>
                    </div>
                </form>
            </section>

            <MovementDocket
                formId="inv-receive-form"
                heading="Receipt docket"
                sign="+"
                total={totalUnits}
                ready={validLines.length > 0}
                facts={[
                    ['Vendor', vendor ? vendor.name : '—'],
                    ['Into', destination ? destination.name : '—', 'inv-docket-strong'],
                    ['Date', fmtDateInput(occurredOn)],
                    ['With photo', `${fmt(validLines.filter((l) => l.photoUrl).length)} of ${fmt(validLines.length)}`]
                ]}
                lines={validLines.map((l) => {
                    const m = matById.get(l.materialId);
                    return {
                        key: l.key,
                        name: m ? m.name : '—',
                        qty: (Number(l.packSize) || 0) * (Number(l.packQty) || 0),
                        unit: m ? m.base_unit : ''
                    };
                })}
                err={err}
                disabled={busy || anyUploading || !validLines.length}
                label={busy ? 'Recording…' : anyUploading ? 'Uploading photo…' : 'Record receipt'}
            />
        </div>
    );
}

// -- Dispatch --------------------------------------------------------------

function DispatchView({ inventory, canMove, onDone, onGoto }) {
    const { materials, locations, balances, createMovementsBatch, createLocation, uploadPhoto, reload, syncBusLocations } = inventory;
    const buOptions = useBuOptions();
    const activeMaterials = materials.filter((m) => m.active);
    const activeLocations = locations.filter((l) => l.active);
    const stores = activeLocations.filter((l) => l.kind === 'store');
    const buLabLocations = activeLocations.filter((l) => l.kind === 'business_unit' || l.kind === 'lab');
    const otherLocations = activeLocations.filter(
        (l) => l.kind !== 'store' && l.kind !== 'business_unit' && l.kind !== 'lab'
    );
    const balMap = useBalanceMap(balances);
    const matById = useMemo(() => new Map(activeMaterials.map((m) => [m.id, m])), [activeMaterials]);

    const [fromLocationId, setFromLocationId] = useState('');
    const [toLocationId, setToLocationId] = useState('');
    const [occurredOn, setOccurredOn] = useState(todayDateInput);
    const [reference, setReference] = useState('');
    const [note, setNote] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const { lines, addLine, removeLine, updateLine, resetLines } = useOrderLines();

    useEffect(() => {
        if (!buOptions.options.length) return;
        syncBusLocations(buOptions.options);
    }, [syncBusLocations, buOptions.options]);

    useEffect(() => {
        if (fromLocationId) return;
        if (stores.length) setFromLocationId(pickDefaultStore(stores, balMap, activeMaterials, LS_DISPATCH_FROM));
        else if (buLabLocations.length) setFromLocationId(buLabLocations[0].id);
        else if (activeLocations.length) setFromLocationId(activeLocations[0].id);
    }, [stores, buLabLocations, activeLocations, fromLocationId, balMap, activeMaterials]);

    useEffect(() => {
        if (toLocationId && toLocationId !== ALL_BUS_DEST && toLocationId === fromLocationId) {
            setToLocationId('');
        }
    }, [fromLocationId, toLocationId]);

    const buLabDestinations = activeLocations.filter(
        (l) => l.id !== fromLocationId && (l.kind === 'business_unit' || l.kind === 'lab')
    );
    const otherDestinations = activeLocations.filter(
        (l) => l.id !== fromLocationId && l.kind !== 'business_unit' && l.kind !== 'lab'
    );
    const isAllBus = toLocationId === ALL_BUS_DEST;
    const allBuEstimate = Math.max(buLabDestinations.length, buOptions.options.length);
    const destCount = isAllBus ? Math.max(allBuEstimate, 1) : 1;
    const source = activeLocations.find((l) => l.id === fromLocationId) || null;
    const dest = activeLocations.find((l) => l.id === toLocationId) || null;

    const fromGroups = useMemo(() => {
        const g = [];
        if (stores.length) g.push({ label: 'Stores & warehouses', items: stores });
        if (buLabLocations.length) g.push({ label: 'Business units & labs', items: buLabLocations });
        if (otherLocations.length) g.push({ label: 'Other locations', items: otherLocations });
        return g;
    }, [stores, buLabLocations, otherLocations]);

    const toGroups = useMemo(() => {
        const g = [];
        if (buLabDestinations.length) g.push({ label: 'Business units & labs', items: buLabDestinations });
        if (otherDestinations.length) g.push({ label: 'Other locations', items: otherDestinations });
        return g;
    }, [buLabDestinations, otherDestinations]);

    const toSpecialOptions = useMemo(() => {
        if (allBuEstimate > 0 || buOptions.options.length > 0) {
            return [{
                value: ALL_BUS_DEST,
                label: `All BUs & labs${allBuEstimate > 0 ? ` (${allBuEstimate})` : ''}`
            }];
        }
        return [];
    }, [allBuEstimate, buOptions.options.length]);

    function onPickMaterial(key, materialId) {
        const m = matById.get(materialId);
        updateLine(key, { materialId, packSize: m ? String(m.default_pack_size || 1) : '' });
    }

    async function onPickPhoto(key, file) {
        updateLine(key, { uploading: true });
        try {
            const url = await uploadPhoto(file);
            updateLine(key, { photoUrl: url, uploading: false });
        } catch (e) {
            updateLine(key, { uploading: false });
            window.alert(`Photo upload failed: ${e.message || e}`);
        }
    }

    // Enrich each line with its derived qty, source availability and overdraw.
    const decorated = lines.map((l) => {
        const qty = (Number(l.packSize) || 0) * (Number(l.packQty) || 0);
        const available = l.materialId && fromLocationId ? balMap.get(balanceKey(l.materialId, fromLocationId)) || 0 : 0;
        const required = qty * destCount;
        const overdraw = qty > 0 && required > available;
        return { ...l, qty, available, required, overdraw };
    });
    const validLines = decorated.filter((l) => l.materialId && l.qty > 0);
    const totalOut = validLines.reduce((s, l) => s + l.required, 0);
    const anyOverdraw = validLines.some((l) => l.overdraw);
    const anyUploading = lines.some((l) => l.uploading);

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!fromLocationId) return setErr('Select a source.');
        if (!toLocationId) return setErr('Select a destination.');
        if (!isAllBus && fromLocationId === toLocationId) return setErr('Source and destination must differ.');
        if (!validLines.length) return setErr('Add at least one material with a pack count.');
        if (isAllBus && allBuEstimate === 0) {
            return setErr('No business units or labs available. Sync client locations or add destinations in Catalog.');
        }
        setBusy(true);
        try {
            const result = await createMovementsBatch({
                kind: 'dispatch',
                from_location_id: fromLocationId,
                ...(isAllBus ? { to_all_bus: true } : { to_location_id: toLocationId }),
                // Unrecorded receipts still get dispatched — let stock go negative
                // so the shortfall is visible in the ledger instead of unrecorded.
                // Sent unconditionally: client-side balances can be stale, and a
                // dispatch must never bounce on the server's stock guard.
                allow_negative: true,
                reference: reference || undefined,
                note: note || undefined,
                occurred_at: dateInputToIso(occurredOn),
                lines: validLines.map((l) => ({
                    material_id: l.materialId,
                    pack_size: Number(l.packSize) || 1,
                    pack_qty: Number(l.packQty),
                    photo_path: l.photoUrl || undefined
                }))
            });
            await reload();
            const moved = (result.movements && result.movements.length) || validLines.length;
            rememberLocation(LS_DISPATCH_FROM, fromLocationId);
            if (isAllBus) {
                const nDest = (result.destination_names && result.destination_names.length) || destCount;
                onDone(`Dispatched ${fmt(validLines.length)} material${validLines.length === 1 ? '' : 's'} to ${fmt(nDest)} BUs/labs (${fmt(moved)} movements).`);
            } else {
                onDone(`Dispatched ${fmt(validLines.length)} material${validLines.length === 1 ? '' : 's'} (${fmt(totalOut)} units) to ${dest ? dest.name : ''}.`);
            }
            resetLines();
            setReference('');
            setNote('');
            setOccurredOn(todayDateInput());
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
                    caption="Pick where it goes, then list every material in the shipment"
                />
                <form id="inv-dispatch-form" className="inv-order-form" onSubmit={onSubmit}>
                    <FormStep n="01" title="Route & paperwork" hint="Applies to every line below">
                        <label className="inv-field">
                            <span>From</span>
                            <LocationCombobox
                                value={fromLocationId}
                                onChange={setFromLocationId}
                                locations={activeLocations}
                                groups={fromGroups}
                                required
                                defaultKind="store"
                                createLocation={createLocation}
                                reload={reload}
                            />
                        </label>
                        <label className="inv-field">
                            <span>To</span>
                            <LocationCombobox
                                value={toLocationId}
                                onChange={setToLocationId}
                                locations={activeLocations.filter((l) => l.id !== fromLocationId)}
                                groups={toGroups}
                                specialOptions={toSpecialOptions}
                                required
                                defaultKind="business_unit"
                                createLocation={createLocation}
                                reload={reload}
                            />
                        </label>
                        <label className="inv-field">
                            <span>Date</span>
                            <input
                                type="date"
                                value={occurredOn}
                                onChange={(e) => setOccurredOn(e.target.value)}
                                required
                            />
                        </label>
                        <label className="inv-field">
                            <span>Reference</span>
                            <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
                        </label>
                        <label className="inv-field inv-field-wide">
                            <span>Note</span>
                            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                        </label>
                    </FormStep>

                    <div className="inv-order-lines">
                        <div className="inv-order-lines-head">
                            <span className="inv-fs-n">02</span>
                            <div className="inv-fs-titles">
                                <span className="inv-fs-title">Materials in this shipment</span>
                                <span className="inv-fs-hint">
                                    {isAllBus && destCount > 1
                                        ? `Quantities are per destination · ${fmt(destCount)} sites`
                                        : 'Pack size defaults from the catalog — override if needed'}
                                </span>
                            </div>
                        </div>
                        <div className="inv-line-table-wrap">
                            <table className="inv-line-table">
                                <thead>
                                    <tr>
                                        <th className="inv-lt-mat">Material</th>
                                        <th className="inv-lt-num">Pack size</th>
                                        <th className="inv-lt-num">Packs</th>
                                        <th className="inv-lt-num">= Units</th>
                                        <th className="inv-lt-num">Available</th>
                                        <th className="inv-lt-photo">Photo</th>
                                        <th aria-label="Remove" />
                                    </tr>
                                </thead>
                                <tbody>
                                    {decorated.map((l) => {
                                        const m = matById.get(l.materialId);
                                        const unit = m ? m.base_unit : '';
                                        return (
                                            <tr key={l.key} className={l.overdraw ? 'is-overdraw' : ''}>
                                                <td className="inv-lt-mat" data-label="Material">
                                                    <MaterialSelect
                                                        value={l.materialId}
                                                        onChange={(v) => onPickMaterial(l.key, v)}
                                                        materials={activeMaterials}
                                                        vendor={null}
                                                    />
                                                </td>
                                                <td className="inv-lt-num" data-label="Pack size">
                                                    <StepInput
                                                        value={l.packSize}
                                                        onChange={(v) => updateLine(l.key, { packSize: v })}
                                                        ariaLabel="Pack size"
                                                    />
                                                </td>
                                                <td className="inv-lt-num" data-label="Packs">
                                                    <StepInput
                                                        value={l.packQty}
                                                        onChange={(v) => updateLine(l.key, { packQty: v })}
                                                        ariaLabel="Number of packs"
                                                    />
                                                </td>
                                                <td className="inv-lt-num inv-lt-total" data-label="= Units">
                                                    {l.qty > 0 ? `${fmt(l.required)}${unit ? ` ${unit}` : ''}` : '—'}
                                                </td>
                                                <td
                                                    className={`inv-lt-num${l.overdraw ? ' inv-lt-warn' : ''}`}
                                                    data-label="Available"
                                                >
                                                    {l.materialId ? fmt(l.available) : '—'}
                                                </td>
                                                <td className="inv-lt-photo" data-label="Photo">
                                                    <LinePhoto
                                                        url={l.photoUrl}
                                                        uploading={l.uploading}
                                                        onPick={(f) => onPickPhoto(l.key, f)}
                                                        onClear={() => updateLine(l.key, { photoUrl: '' })}
                                                    />
                                                </td>
                                                <td className="inv-lt-x" data-label="">
                                                    <button
                                                        type="button"
                                                        className="inv-line-remove"
                                                        onClick={() => removeLine(l.key)}
                                                        disabled={lines.length === 1}
                                                        aria-label="Remove line"
                                                    >
                                                        ×
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                        <button type="button" className="inv-line-add" onClick={addLine}>
                            + Add material
                        </button>
                    </div>
                </form>
            </section>

            <MovementDocket
                formId="inv-dispatch-form"
                heading="Dispatch docket"
                sign="−"
                total={totalOut}
                ready={validLines.length > 0}
                warn={anyOverdraw}
                facts={[
                    ['From', source ? source.name : '—'],
                    ['To', isAllBus ? `All BUs & labs (${fmt(destCount)})` : dest ? dest.name : '—', 'inv-docket-strong'],
                    ['Date', fmtDateInput(occurredOn)],
                    ...(isAllBus && destCount > 1
                        ? [['Per destination', `${fmt(validLines.reduce((s, l) => s + l.qty, 0))} units`]]
                        : []),
                    ['With photo', `${fmt(validLines.filter((l) => l.photoUrl).length)} of ${fmt(validLines.length)}`]
                ]}
                lines={validLines.map((l) => {
                    const m = matById.get(l.materialId);
                    return {
                        key: l.key,
                        name: m ? m.name : '—',
                        qty: l.required,
                        unit: m ? m.base_unit : '',
                        warn: l.overdraw
                    };
                })}
                note={
                    anyOverdraw
                        ? `Lines marked in amber exceed recorded stock at ${source ? source.name : 'the source'}${
                              isAllBus && destCount > 1 ? ` across ${fmt(destCount)} destinations` : ''
                          }. Dispatching takes it negative — right for stock that was never recorded on receipt.`
                        : null
                }
                err={err}
                disabled={busy || anyUploading || !validLines.length || (isAllBus && allBuEstimate === 0)}
                label={busy ? 'Dispatching…' : anyUploading ? 'Uploading photo…' : isAllBus ? 'Dispatch to all BUs/labs' : 'Record dispatch'}
            />
        </div>
    );
}

// -- Ledger ----------------------------------------------------------------

/**
 * Time of day for a ledger row. Movements entered through the forms carry a
 * calendar date only — the client stamps them at local noon so the day never
 * shifts across timezones — and printing "12:00" on every one of those rows
 * was noise dressed as data. Only a real clock time is shown.
 */
function fmtWhenTime(d) {
    if (d.getHours() === 12 && d.getMinutes() === 0 && d.getSeconds() === 0) return '';
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function shiftDateInput(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthStartDateInput() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

/** Local calendar date (YYYY-MM-DD) → ISO at local midnight, shifted by `dayOffset` days. */
function dateInputToIsoDayStart(dateStr, dayOffset = 0) {
    const [y, m, d] = String(dateStr).split('-').map(Number);
    if (!y || !m || !d) return null;
    return new Date(y, m - 1, d + dayOffset).toISOString();
}

// Quick date picks for the ledger. Each yields the from/to input values it
// represents so a custom pair that happens to match still lights the chip.
const LEDGER_RANGES = [
    { id: 'all', label: 'All time', build: () => ({ from: '', to: '' }) },
    { id: 'today', label: 'Today', build: () => ({ from: todayDateInput(), to: todayDateInput() }) },
    { id: '7d', label: '−7d', build: () => ({ from: shiftDateInput(-6), to: todayDateInput() }) },
    { id: '30d', label: '−30d', build: () => ({ from: shiftDateInput(-29), to: todayDateInput() }) },
    { id: 'month', label: 'This month', build: () => ({ from: monthStartDateInput(), to: todayDateInput() }) }
];

const LEDGER_EMPTY_FILTERS = {
    q: '',
    kind: '',
    materialId: '',
    locationId: '',
    vendorId: '',
    from: '',
    to: '',
    hideVoided: false
};

const LEDGER_PAGE = 50;

function LedgerView({ inventory, canMove, onDone }) {
    const { materials, locations, vendors, fetchMovements, voidMovement, reload } = inventory;
    const [rows, setRows] = useState([]);
    const [cursor, setCursor] = useState(null);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [err, setErr] = useState(null);
    const [filters, setFilters] = useState(LEDGER_EMPTY_FILTERS);
    // The search box updates on every keystroke; the query we actually send
    // trails it so a fast typist doesn't fire a request per character.
    const [search, setSearch] = useState('');

    useEffect(() => {
        const t = setTimeout(() => {
            setFilters((f) => (f.q === search.trim() ? f : { ...f, q: search.trim() }));
        }, 250);
        return () => clearTimeout(t);
    }, [search]);

    const setFilter = useCallback((patch) => setFilters((f) => ({ ...f, ...patch })), []);

    const apiParams = useMemo(() => {
        const p = { limit: LEDGER_PAGE };
        if (filters.q) p.q = filters.q;
        if (filters.kind) p.kind = filters.kind;
        if (filters.materialId) p.material_id = filters.materialId;
        if (filters.locationId) p.location_id = filters.locationId;
        if (filters.vendorId) p.vendor_id = filters.vendorId;
        if (filters.from) p.from = dateInputToIsoDayStart(filters.from);
        // `to` is inclusive of the whole day, so send the next day's midnight.
        if (filters.to) p.to = dateInputToIsoDayStart(filters.to, 1);
        if (filters.hideVoided) p.voided = 'exclude';
        return p;
    }, [filters]);

    const load = useCallback(
        async (reset, beforeId) => {
            setLoading(true);
            setErr(null);
            try {
                const params = { ...apiParams };
                if (!reset && beforeId) params.before_id = beforeId;
                const j = await fetchMovements(params);
                const next = j.movements || [];
                setRows((prev) => (reset ? next : [...prev, ...next]));
                setCursor(j.next_cursor || null);
                setTotal(Number(j.total) || 0);
            } catch (e) {
                setErr(String(e.message || e));
            } finally {
                setLoading(false);
            }
        },
        [fetchMovements, apiParams]
    );

    useEffect(() => {
        setCursor(null);
        load(true);
    }, [load]);

    const activeCount = Object.keys(LEDGER_EMPTY_FILTERS).filter((k) => filters[k] !== LEDGER_EMPTY_FILTERS[k]).length;

    const clearFilters = () => {
        setSearch('');
        setFilters(LEDGER_EMPTY_FILTERS);
    };

    const activeRange = LEDGER_RANGES.find((r) => {
        const t = r.build();
        return t.from === filters.from && t.to === filters.to;
    });

    // Every location that has ever appeared on a movement is a useful filter,
    // so inactive ones stay in the list; they just sit below the active set.
    const locationOptions = useMemo(
        () => [...locations].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)),
        [locations]
    );

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

    const caption = loading && !rows.length
        ? 'Loading…'
        : total
          ? `${fmt(rows.length)} of ${fmt(total)} movement${total === 1 ? '' : 's'}${activeCount ? ' match' : ''}`
          : activeCount
            ? 'No movements match these filters.'
            : 'Append-only. Voided rows stay in history but stop counting.';

    return (
        <section className="inv-panel">
            <SectionHead title="Movement ledger" caption={caption}>
                <input
                    className="inv-search inv-ledger-search"
                    type="search"
                    placeholder="Search material, reference, note, vendor, location…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    aria-label="Search movements"
                />
                {activeCount > 0 && (
                    <button type="button" className="chip chip-tool" onClick={clearFilters}>
                        Clear {activeCount > 1 ? `(${activeCount})` : ''}
                    </button>
                )}
            </SectionHead>

            <div className="inv-ledger-filters" role="group" aria-label="Ledger filters">
                <div className="inv-ledger-filter-row">
                    <select
                        className="inv-search inv-ledger-select"
                        value={filters.kind}
                        onChange={(e) => setFilter({ kind: e.target.value })}
                        aria-label="Filter by type"
                    >
                        <option value="">All types</option>
                        <option value="receipt">Receipt</option>
                        <option value="dispatch">Dispatch</option>
                        <option value="adjustment">Adjustment</option>
                    </select>
                    <select
                        className="inv-search inv-ledger-select"
                        value={filters.materialId}
                        onChange={(e) => setFilter({ materialId: e.target.value })}
                        aria-label="Filter by material"
                    >
                        <option value="">All materials</option>
                        {materials.map((m) => (
                            <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (inactive)'}</option>
                        ))}
                    </select>
                    <select
                        className="inv-search inv-ledger-select"
                        value={filters.locationId}
                        onChange={(e) => setFilter({ locationId: e.target.value })}
                        aria-label="Filter by location"
                    >
                        <option value="">All locations</option>
                        {locationOptions.map((l) => (
                            <option key={l.id} value={l.id}>
                                {l.name} · {kindLabel(l.kind)}{l.active ? '' : ' (inactive)'}
                            </option>
                        ))}
                    </select>
                    <select
                        className="inv-search inv-ledger-select"
                        value={filters.vendorId}
                        onChange={(e) => setFilter({ vendorId: e.target.value })}
                        aria-label="Filter by vendor"
                    >
                        <option value="">All vendors</option>
                        {vendors.map((v) => (
                            <option key={v.id} value={v.id}>{v.name}{v.active ? '' : ' (inactive)'}</option>
                        ))}
                    </select>
                </div>
                <div className="inv-ledger-filter-row">
                    <div className="chip-row" role="group" aria-label="Date quick picks">
                        {LEDGER_RANGES.map((r) => (
                            <button
                                key={r.id}
                                type="button"
                                className="chip chip-tool"
                                aria-pressed={activeRange && activeRange.id === r.id ? 'true' : 'false'}
                                onClick={() => setFilter(r.build())}
                            >
                                {r.label}
                            </button>
                        ))}
                    </div>
                    <label className="inv-ledger-date">
                        <span>From</span>
                        <input
                            className="inv-search"
                            type="date"
                            value={filters.from}
                            max={filters.to || undefined}
                            onChange={(e) => setFilter({ from: e.target.value })}
                        />
                    </label>
                    <label className="inv-ledger-date">
                        <span>To</span>
                        <input
                            className="inv-search"
                            type="date"
                            value={filters.to}
                            min={filters.from || undefined}
                            onChange={(e) => setFilter({ to: e.target.value })}
                        />
                    </label>
                    <label className="inv-toggle">
                        <input
                            type="checkbox"
                            className="inv-toggle-input"
                            checked={filters.hideVoided}
                            onChange={(e) => setFilter({ hideVoided: e.target.checked })}
                        />
                        <span className="inv-toggle-track" aria-hidden="true">
                            <span className="inv-toggle-thumb" />
                        </span>
                        <span className="inv-toggle-label">Hide voided</span>
                    </label>
                </div>
            </div>

            {err && <div className="results-error nexus-card">{err}</div>}

            <div className="inv-table-wrap">
                <table className="inv-table inv-ledger-table">
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
                                        {fmtWhenTime(when) && <span className="inv-when-time">{fmtWhenTime(when)}</span>}
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
                                        {r.photo_path && (
                                            <a
                                                className="inv-ledger-thumb"
                                                href={apiUrl(r.photo_path)}
                                                target="_blank"
                                                rel="noreferrer"
                                                title="Open proof photo"
                                            >
                                                <img src={apiUrl(r.photo_path)} alt="proof" />
                                            </a>
                                        )}
                                        {(r.vendor_name || r.vendor) && <div>Vendor: {r.vendor_name || r.vendor}</div>}
                                        {r.reference && <div>Ref: {r.reference}</div>}
                                        {r.note && <div>{r.note}</div>}
                                        {r.voided_at && (
                                            <span className="inv-void-tag">
                                                voided {new Date(r.voided_at).toLocaleDateString()}
                                            </span>
                                        )}
                                        {!r.photo_path && !r.vendor_name && !r.vendor && !r.reference && !r.note && !r.voided_at && (
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
                                    {activeCount ? (
                                        <EmptyState
                                            icon="list"
                                            title="No matching movements"
                                            action={
                                                <button type="button" className="chip chip-tool" onClick={clearFilters}>
                                                    Clear filters
                                                </button>
                                            }
                                        >
                                            Try a wider date range or fewer filters.
                                        </EmptyState>
                                    ) : (
                                        <EmptyState icon="list" title="No movements yet">
                                            Recorded receipts and dispatches will appear here.
                                        </EmptyState>
                                    )}
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {cursor && (
                <div className="inv-loadmore">
                    <button type="button" className="chip chip-tool" disabled={loading} onClick={() => load(false, cursor)}>
                        {loading ? 'Loading…' : `Load more (${fmt(total - rows.length)} left)`}
                    </button>
                </div>
            )}
        </section>
    );
}

// -- Vendors ---------------------------------------------------------------

function VendorMaterialPicker({ materials, selected, onToggle }) {
    if (!materials.length) {
        return <p className="muted small">No materials in the catalog yet. Add materials first to link them.</p>;
    }
    return (
        <div className="inv-vendor-picker chip-grid" role="group" aria-label="Materials supplied">
            {materials.map((m) => {
                const on = selected.has(m.id);
                return (
                    <button
                        key={m.id}
                        type="button"
                        className="chip"
                        aria-pressed={on ? 'true' : 'false'}
                        onClick={() => onToggle(m.id)}
                    >
                        {m.name}
                    </button>
                );
            })}
        </div>
    );
}

function VendorForm({ vendor, materials, onSubmit, onCancel, busy, err }) {
    const [name, setName] = useState(vendor ? vendor.name : '');
    const [contactPerson, setContactPerson] = useState(vendor ? vendor.contact_person || '' : '');
    const [phone, setPhone] = useState(vendor ? vendor.phone || '' : '');
    const [email, setEmail] = useState(vendor ? vendor.email || '' : '');
    const [address, setAddress] = useState(vendor ? vendor.address || '' : '');
    const [gst, setGst] = useState(vendor ? vendor.gst_number || '' : '');
    const [note, setNote] = useState(vendor ? vendor.note || '' : '');
    const [selected, setSelected] = useState(() => new Set(vendor ? vendor.material_ids || [] : []));

    const activeMaterials = materials.filter((m) => m.active);

    const toggle = useCallback((id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    function submit(e) {
        e.preventDefault();
        onSubmit({
            name: name.trim(),
            contact_person: contactPerson.trim() || undefined,
            phone: phone.trim() || undefined,
            email: email.trim() || undefined,
            address: address.trim() || undefined,
            gst_number: gst.trim() || undefined,
            note: note.trim() || undefined,
            material_ids: [...selected]
        });
    }

    return (
        <form className="inv-inline-form inv-vendor-form" onSubmit={submit}>
            <div className="inv-fs-grid">
                <label className="inv-field">
                    <span>Vendor name</span>
                    <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
                </label>
                <label className="inv-field">
                    <span>Contact person</span>
                    <input value={contactPerson} onChange={(e) => setContactPerson(e.target.value)} placeholder="Optional" />
                </label>
                <label className="inv-field">
                    <span>Mobile number</span>
                    <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Optional" />
                </label>
                <label className="inv-field">
                    <span>Email</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Optional" />
                </label>
                <label className="inv-field">
                    <span>GST number</span>
                    <input
                        value={gst}
                        onChange={(e) => setGst(e.target.value.toUpperCase())}
                        placeholder="Optional"
                    />
                </label>
                <label className="inv-field inv-field-wide">
                    <span>Address</span>
                    <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Optional" />
                </label>
                <label className="inv-field inv-field-wide">
                    <span>Note</span>
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
                </label>
            </div>
            <div className="inv-vendor-materials">
                <span className="inv-vendor-materials-label">Materials supplied ({selected.size})</span>
                <VendorMaterialPicker materials={activeMaterials} selected={selected} onToggle={toggle} />
            </div>
            {err && <p className="login-err">{err}</p>}
            <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? 'Saving…' : vendor ? 'Save vendor' : 'Add vendor'}
                </button>
                <button type="button" className="chip chip-tool" onClick={onCancel} disabled={busy}>
                    Cancel
                </button>
            </div>
        </form>
    );
}

function VendorsView({ inventory, canManageCatalog, onDone }) {
    const { vendors, materials, createVendor, updateVendor, reload } = inventory;
    const [mode, setMode] = useState(null); // null | 'new' | vendorId being edited
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    const materialName = useMemo(() => {
        const map = new Map();
        for (const m of materials) map.set(m.id, m.name);
        return map;
    }, [materials]);

    const editing = typeof mode === 'string' && mode !== 'new' ? vendors.find((v) => v.id === mode) || null : null;

    async function handleSubmit(body) {
        setErr(null);
        if (!body.name) return setErr('Vendor name is required.');
        setBusy(true);
        try {
            if (mode === 'new') {
                await createVendor(body);
                onDone(`Onboarded vendor “${body.name}”.`);
            } else {
                await updateVendor(mode, body);
                onDone(`Updated vendor “${body.name}”.`);
            }
            await reload();
            setMode(null);
        } catch (e) {
            setErr(String(e.message || e));
        } finally {
            setBusy(false);
        }
    }

    async function toggleActive(v) {
        try {
            await updateVendor(v.id, { active: !v.active });
            await reload();
        } catch (e) {
            window.alert(String(e.message || e));
        }
    }

    if (!canManageCatalog && !vendors.length) {
        return (
            <EmptyState icon="truck" title="No vendors yet">
                No suppliers have been onboarded. Ask an admin to add vendors.
            </EmptyState>
        );
    }

    return (
        <section className="inv-panel">
            <SectionHead title="Vendors" caption={`${fmt(vendors.length)} onboarded suppliers`}>
                {canManageCatalog && mode == null && (
                    <button type="button" className="btn-primary btn-sm" onClick={() => { setErr(null); setMode('new'); }}>
                        + New vendor
                    </button>
                )}
            </SectionHead>

            {canManageCatalog && mode === 'new' && (
                <VendorForm
                    materials={materials}
                    onSubmit={handleSubmit}
                    onCancel={() => setMode(null)}
                    busy={busy}
                    err={err}
                />
            )}

            {vendors.length ? (
                <div className="inv-table-wrap">
                    <table className="inv-table inv-vendors-table">
                        <thead>
                            <tr>
                                <th>Vendor</th>
                                <th>Contact</th>
                                <th>GST</th>
                                <th>Supplies</th>
                                {canManageCatalog && <th />}
                            </tr>
                        </thead>
                        <tbody>
                            {vendors.map((v) => (
                                <VendorRow
                                    key={v.id}
                                    vendor={v}
                                    materials={materials}
                                    materialName={materialName}
                                    canManageCatalog={canManageCatalog}
                                    isEditing={editing && editing.id === v.id}
                                    onEdit={() => { setErr(null); setMode(v.id); }}
                                    onCancel={() => setMode(null)}
                                    onToggle={() => toggleActive(v)}
                                    onSubmit={handleSubmit}
                                    busy={busy}
                                    err={err}
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
            ) : (
                <EmptyState icon="truck" title="No vendors yet" action={
                    canManageCatalog ? (
                        <button type="button" className="btn-primary" onClick={() => setMode('new')}>
                            Onboard your first vendor
                        </button>
                    ) : null
                }>
                    Vendors you buy stock from will appear here, and become selectable in the Receive tab.
                </EmptyState>
            )}
        </section>
    );
}

function VendorRow({ vendor, materials, materialName, canManageCatalog, isEditing, onEdit, onCancel, onToggle, onSubmit, busy, err }) {
    const v = vendor;
    const supplies = (v.material_ids || []).map((id) => materialName.get(id)).filter(Boolean);
    const colSpan = canManageCatalog ? 5 : 4;
    const SUPPLY_PREVIEW = 3;
    const supplyPreview = supplies.slice(0, SUPPLY_PREVIEW).join(', ');
    const supplyMore = supplies.length - SUPPLY_PREVIEW;

    if (isEditing) {
        return (
            <tr>
                <td colSpan={colSpan} className="inv-vendor-edit-cell">
                    <VendorForm
                        vendor={v}
                        materials={materials}
                        onSubmit={onSubmit}
                        onCancel={onCancel}
                        busy={busy}
                        err={err}
                    />
                </td>
            </tr>
        );
    }

    return (
        <tr className={v.active ? '' : 'inv-inactive'}>
            <td className="inv-mat-cell inv-vendor-name">
                {v.name}
                {!v.active && <span className="inv-inactive-tag">inactive</span>}
                {v.address && <span className="inv-vendor-addr">{v.address}</span>}
            </td>
            <td className="inv-vendor-contact">
                {v.contact_person || v.phone || v.email ? (
                    <>
                        {v.contact_person && <span>{v.contact_person}</span>}
                        {v.phone && <span className="inv-vendor-contact-line">{v.phone}</span>}
                        {v.email && <span className="inv-vendor-contact-line">{v.email}</span>}
                    </>
                ) : (
                    <span className="inv-dash">·</span>
                )}
            </td>
            <td className="inv-vendor-gst">{v.gst_number || <span className="inv-dash">·</span>}</td>
            <td className="inv-vendor-supplies" title={supplies.length ? supplies.join(', ') : undefined}>
                {supplies.length ? (
                    <>
                        {supplyPreview}
                        {supplyMore > 0 && <span className="inv-vendor-supplies-more"> +{supplyMore}</span>}
                    </>
                ) : (
                    <span className="inv-dash">·</span>
                )}
            </td>
            {canManageCatalog && (
                <td className="inv-row-actions">
                    <button type="button" className="chip chip-tool" onClick={onEdit}>Edit</button>
                    <button type="button" className="chip chip-tool" onClick={onToggle}>
                        {v.active ? 'Disable' : 'Enable'}
                    </button>
                </td>
            )}
        </tr>
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
                        to add the standard materials list and a Central Store, or add items manually below.
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
    const [query, setQuery] = useState('');
    const [editingReorder, setEditingReorder] = useState(null); // material id being edited inline

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q ? materials.filter((m) => m.name.toLowerCase().includes(q)) : materials;
    }, [materials, query]);

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

    // Reorder level edits inline in the row — a browser prompt interrupts a
    // task that needs neither a dialog nor protected focus.
    async function saveReorder(m, raw) {
        const val = Number(raw);
        if (!Number.isFinite(val) || val < 0) return 'Enter a number of 0 or more.';
        if (val === Number(m.reorder_level)) {
            setEditingReorder(null);
            return null;
        }
        try {
            await updateMaterial(m.id, { reorder_level: val });
            await reload();
            onDone(`Reorder level for ${m.name} set to ${fmt(val)}.`);
            setEditingReorder(null);
            return null;
        } catch (e) {
            return String(e.message || e);
        }
    }

    const caption =
        query.trim() && shown.length !== materials.length
            ? `${fmt(shown.length)} of ${fmt(materials.length)} materials match`
            : `${fmt(materials.length)} in catalog · ${fmt(materials.filter((m) => !m.active).length)} inactive`;

    return (
        <section className="inv-panel">
            <SectionHead title="Materials" caption={caption}>
                <input
                    className="inv-search"
                    type="search"
                    placeholder="Filter materials…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Filter materials"
                />
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
                            <tr><th>Material</th><th className="num">Reorder</th><th /></tr>
                        </thead>
                        <tbody>
                            {shown.map((m) => (
                                <tr key={m.id} className={m.active ? '' : 'inv-inactive'}>
                                    <td>
                                        <span className="inv-mat-name">
                                            {m.name}
                                            {!m.active && <span className="inv-inactive-tag">inactive</span>}
                                        </span>
                                        <span className="inv-unit">{m.base_unit}</span>
                                    </td>
                                    <td className="num inv-reorder-cell">
                                        {editingReorder === m.id ? (
                                            <ReorderEditor
                                                initial={m.reorder_level}
                                                onSave={(raw) => saveReorder(m, raw)}
                                                onCancel={() => setEditingReorder(null)}
                                            />
                                        ) : m.reorder_level ? (
                                            fmt(m.reorder_level)
                                        ) : (
                                            <span className="inv-dash">·</span>
                                        )}
                                    </td>
                                    <td className="inv-row-actions">
                                        {editingReorder !== m.id && (
                                            <button type="button" className="chip chip-tool" onClick={() => setEditingReorder(m.id)}>
                                                Set reorder
                                            </button>
                                        )}
                                        <button type="button" className="chip chip-tool" onClick={() => toggleActive(m)}>
                                            {m.active ? 'Disable' : 'Enable'}
                                        </button>
                                    </td>
                                </tr>
                            ))}
                            {!shown.length && (
                                <tr>
                                    <td colSpan={3} className="muted inv-nomatch">No materials match “{query}”.</td>
                                </tr>
                            )}
                        </tbody>
                    </table>
                </div>
            ) : (
                <p className="muted small inv-panel-empty">No materials yet.</p>
            )}
        </section>
    );
}

/** Inline number editor for a reorder level: Enter saves, Escape cancels. */
function ReorderEditor({ initial, onSave, onCancel }) {
    const [val, setVal] = useState(String(initial ?? 0));
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    async function save() {
        setBusy(true);
        const e = await onSave(val);
        setBusy(false);
        if (e) setErr(e);
    }
    return (
        <span className="inv-reorder-editor">
            <input
                type="number"
                min="0"
                value={val}
                autoFocus
                aria-label="Reorder level"
                disabled={busy}
                onChange={(e) => setVal(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                        e.preventDefault();
                        save();
                    } else if (e.key === 'Escape') {
                        onCancel();
                    }
                }}
            />
            <button type="button" className="chip chip-tool" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save'}
            </button>
            <button type="button" className="chip chip-tool" onClick={onCancel} disabled={busy}>
                Cancel
            </button>
            {err && <span className="inv-reorder-err">{err}</span>}
        </span>
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
    const [query, setQuery] = useState('');

    const shown = useMemo(() => {
        const q = query.trim().toLowerCase();
        return q
            ? locations.filter(
                  (l) =>
                      l.name.toLowerCase().includes(q) ||
                      String(l.bu_code || '').toLowerCase().includes(q) ||
                      String(l.client_code || '').toLowerCase().includes(q)
              )
            : locations;
    }, [locations, query]);

    const storeCount = locations.filter((l) => l.kind === 'store').length;
    const caption =
        query.trim() && shown.length !== locations.length
            ? `${fmt(shown.length)} of ${fmt(locations.length)} locations match`
            : `${fmt(storeCount)} ${storeCount === 1 ? 'store' : 'stores'}, ${fmt(locations.length - storeCount)} BUs and labs · ${fmt(
                  locations.filter((l) => !l.active).length
              )} inactive`;

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
            <SectionHead title="Locations" caption={caption}>
                <input
                    className="inv-search"
                    type="search"
                    placeholder="Filter by name or code…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    aria-label="Filter locations"
                />
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
                            {shown.map((l) => (
                                <tr key={l.id} className={l.active ? '' : 'inv-inactive'}>
                                    <td className="inv-mat-cell">
                                        {l.name}
                                        {!l.active && <span className="inv-inactive-tag">inactive</span>}
                                    </td>
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
