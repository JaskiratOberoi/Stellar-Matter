// Tracer demand -> catalog materials.
//
// Each Tracer column is compared with the stock of one or more catalog items
// (vacuum and non-vacuum tubes count together), and a planned dispatch sends
// one item per column. Letter heads are Noble only. Matching is by catalog
// name, so a renamed material simply drops out of the comparison.
//
// Stock is only compared at stores: business units don't record what they
// use yet, so their balances only ever grow and would hide real demand.
export const DEMAND_MAP = [
    { col: 'lh', stock: ['Noble Letterhead'], send: 'Noble Letterhead' },
    { col: 'envBig', stock: ['Envelopes (Big)'], send: 'Envelopes (Big)' },
    { col: 'envSmall', stock: ['Envelopes (Small)'], send: 'Envelopes (Small)' },
    { col: 'urine', stock: ['Urine Containers'], send: 'Urine Containers' },
    { col: 'edta', stock: ['EDTA Vials', 'EDTA Vacuum'], send: 'EDTA Vials', mixed: true },
    { col: 'flouride', stock: ['Flouride Vials', 'Flouride Vacuum'], send: 'Flouride Vials', mixed: true },
    { col: 'citrate', stock: ['Citrate Vials'], send: 'Citrate Vials' },
    { col: 'sHep', stock: ['S.Heparin'], send: 'S.Heparin' },
    { col: 'lHep', stock: ['L.Heparin'], send: 'L.Heparin' },
    { col: 'lbc', stock: ['LBC'], send: 'LBC' },
    { col: 'barcode', stock: ['Barcode Labels'], send: 'Barcode Labels' },
    { col: 'serum', stock: ['Serum Tubes', 'Serum Vacuum'], send: 'Serum Tubes', mixed: true }
];

const norm = (s) => String(s || '').trim().toLowerCase();

/** Total stock across all stores for each Tracer column. */
export function storeCoverByColumn({ materials, locations, balances }) {
    const byName = new Map(materials.filter((m) => m.active).map((m) => [norm(m.name), m.id]));
    const storeIds = new Set(locations.filter((l) => l.active && l.kind === 'store').map((l) => l.id));
    const onHand = new Map();
    for (const b of balances) {
        if (!storeIds.has(b.location_id)) continue;
        onHand.set(b.material_id, (onHand.get(b.material_id) || 0) + Math.max(0, Number(b.on_hand) || 0));
    }
    const out = {};
    for (const d of DEMAND_MAP) {
        const ids = d.stock.map((n) => byName.get(norm(n))).filter(Boolean);
        out[d.col] = ids.length ? ids.reduce((s, id) => s + (onHand.get(id) || 0), 0) : null;
    }
    return out;
}

/** The inventory business unit a Tracer row stands for, by name or BU code. */
export function locationForUnit(label, locations) {
    const key = norm(label);
    return (
        locations.find((l) => l.active && l.kind === 'business_unit' && (norm(l.bu_code) === key || norm(l.name) === key)) ||
        null
    );
}

/**
 * Dispatch draft lines for one unit's demand: one line per column with a
 * count, rounded up to whole packs of the catalog's default pack size.
 */
export function dispatchLinesForDemand(vals, materials) {
    const byName = new Map(materials.filter((m) => m.active).map((m) => [norm(m.name), m]));
    const lines = [];
    const mixed = [];
    for (const d of DEMAND_MAP) {
        const qty = vals[d.col];
        if (!qty || qty <= 0) continue;
        const m = byName.get(norm(d.send));
        if (!m) continue;
        const pack = Math.max(1, Number(m.default_pack_size) || 1);
        lines.push({ materialId: m.id, packSize: String(pack), packQty: String(Math.ceil(qty / pack)), photoUrl: '' });
        if (d.mixed) mixed.push(m.name);
    }
    return { lines, mixed };
}
