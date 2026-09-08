'use strict';

// Dev-only sample data for the inventory tracker.
//
//   npm run seed:dev            # add ~150 movements over the last 60 days
//   npm run seed:dev -- --reset # wipe previous dev rows first, then re-seed
//
// Everything this script writes is tagged so it can be found again: movement
// references start with "DEV-", and locations/vendors it creates carry a
// "[dev]" note or name suffix. Real rows are never touched. Refuses to run
// when NODE_ENV=production unless --force is passed.
//
// The generator is deterministic (seeded PRNG) so two people running it get
// the same ledger, which makes "look at row 37" conversations possible.

const { getPool, closePool, useDatabase } = require('./pool');
const { DEFAULT_ORG_ID } = require('./orgConstants');
const inv = require('./inventory');

const DEV_REF_PREFIX = 'DEV-';
const DEV_ACTOR = 'user-super-admin';
const DAYS_BACK = 60;

const DEV_LOCATIONS = [
    { name: 'Rohtak BU', kind: 'business_unit', buCode: 'RTK' },
    { name: 'Jammu BU', kind: 'business_unit', buCode: 'JMU' },
    { name: 'Agra BU', kind: 'business_unit', buCode: 'AGR' },
    { name: 'Genomics Lab · Gurugram', kind: 'lab', clientCode: 'GGN-GEN' },
    { name: 'Cytology Lab · Delhi', kind: 'lab', clientCode: 'DEL-CYT' }
];

const DEV_VENDORS = [
    {
        name: 'Medline Surgicals [dev]',
        contactPerson: 'Rakesh Verma',
        phone: '+91 98110 22334',
        email: 'orders@medline-surgicals.example',
        gstNumber: '07AAACM1234A1Z5',
        materials: ['EDTA Vials', 'Serum Tubes', 'Citrate Vials', 'S.Heparin', 'L.Heparin', 'Flouride Vials', 'Vacuum Needle', 'Syringe 3ml', 'Syringe 5ml']
    },
    {
        name: 'Sharma Printers [dev]',
        contactPerson: 'Neha Sharma',
        phone: '+91 98765 43210',
        email: 'neha@sharmaprinters.example',
        gstNumber: '06AABCS9876B1Z2',
        materials: ['Letter Heads', 'Envelopes (Big)', 'Envelopes (Small)', 'Barcode Labels', 'TRF Big', 'TRF - 5 Line', 'Noble Letterhead']
    },
    {
        name: 'SafeCare Disposables [dev]',
        contactPerson: 'Imran Qureshi',
        phone: '+91 99880 11223',
        email: 'sales@safecare.example',
        gstNumber: '09AAECS4567C1Z8',
        materials: ['Gloves', 'Mask', 'Sanitizer', 'Urine Containers', 'Biowaste Polybags - Yellow', 'Sharp Container - Blue', 'Cotton Roll']
    }
];

const NOTES = [
    null,
    null,
    null,
    'Monthly top-up',
    'Urgent — courier same day',
    'Partial delivery, balance pending',
    'Received against PO',
    'Damaged box replaced by vendor',
    'Camp requirement',
    'Sent with sample pickup van'
];

// mulberry32 — tiny seeded PRNG, good enough for sample data.
function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function pick(rand, arr) {
    return arr[Math.floor(rand() * arr.length)];
}

function intBetween(rand, lo, hi) {
    return lo + Math.floor(rand() * (hi - lo + 1));
}

function parseArgs(argv) {
    const args = { reset: false, force: false, org: DEFAULT_ORG_ID };
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--reset') args.reset = true;
        else if (a === '--force') args.force = true;
        else if (a === '--org') args.org = argv[++i];
        else if (a.startsWith('--org=')) args.org = a.slice('--org='.length);
    }
    return args;
}

async function ensureLocations(orgId) {
    const existing = await inv.listLocations(orgId, { includeInactive: true });
    const byName = new Map(existing.map((l) => [l.name, l]));
    for (const spec of DEV_LOCATIONS) {
        if (byName.has(spec.name)) continue;
        const loc = await inv.createLocation(orgId, spec);
        byName.set(loc.name, loc);
        console.log(`  + location ${loc.name}`);
    }
    return [...byName.values()];
}

async function ensureVendors(orgId, materials) {
    const existing = await inv.listVendors(orgId, { includeInactive: true });
    const byName = new Map(existing.map((v) => [v.name, v]));
    const matByName = new Map(materials.map((m) => [m.name, m]));
    for (const spec of DEV_VENDORS) {
        if (byName.has(spec.name)) continue;
        const materialIds = spec.materials.map((n) => matByName.get(n)).filter(Boolean).map((m) => m.id);
        const vendor = await inv.createVendor(orgId, {
            name: spec.name,
            contactPerson: spec.contactPerson,
            phone: spec.phone,
            email: spec.email,
            gstNumber: spec.gstNumber,
            note: 'Sample vendor created by seed:dev',
            materialIds
        });
        byName.set(vendor.name, vendor);
        console.log(`  + vendor ${vendor.name} (${materialIds.length} materials)`);
    }
    return DEV_VENDORS.map((spec) => byName.get(spec.name)).filter(Boolean);
}

async function resetDevRows(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `DELETE FROM inventory_movements WHERE org_id = $1 AND reference LIKE $2`,
        [orgId, `${DEV_REF_PREFIX}%`]
    );
    console.log(`  - removed ${r.rowCount} previous dev movement(s)`);
}

async function alreadySeeded(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT COUNT(*)::int AS c FROM inventory_movements WHERE org_id = $1 AND reference LIKE $2`,
        [orgId, `${DEV_REF_PREFIX}%`]
    );
    return r.rows[0].c;
}

/**
 * Plan a chronological list of movements. Receipts land in the store first so
 * the on-hand guard in insertMovementTx never trips on a dispatch; a running
 * balance per material keeps every dispatch within what the store holds.
 */
function planMovements(rand, { materials, store, destinations, vendors }) {
    const now = Date.now();
    const dayMs = 86_400_000;
    const plan = [];
    const balance = new Map(materials.map((m) => [m.id, 0]));
    const vendorFor = new Map();
    for (const v of vendors) for (const mid of v.material_ids || []) vendorFor.set(mid, v);

    let refSeq = 1000;
    const ref = () => `${DEV_REF_PREFIX}${new Date(now).getFullYear()}-${refSeq++}`;

    for (let day = DAYS_BACK; day >= 0; day -= 1) {
        const dayStart = now - day * dayMs;
        // Receipts: a couple most days, bigger deliveries on Mondays.
        const isMonday = new Date(dayStart).getDay() === 1;
        const receipts = isMonday ? intBetween(rand, 3, 5) : intBetween(rand, 0, 2);
        for (let i = 0; i < receipts; i += 1) {
            const m = pick(rand, materials);
            const packQty = intBetween(rand, 2, 20);
            const qty = packQty * m.default_pack_size;
            const vendor = vendorFor.get(m.id) || pick(rand, vendors);
            balance.set(m.id, balance.get(m.id) + qty);
            plan.push({
                materialId: m.id,
                kind: 'receipt',
                toLocationId: store.id,
                qtyBase: qty,
                packSize: m.default_pack_size,
                packQty,
                vendorId: vendor.id,
                reference: ref(),
                note: pick(rand, NOTES),
                occurredAt: new Date(dayStart + intBetween(rand, 9, 12) * 3_600_000 + intBetween(rand, 0, 59) * 60_000)
            });
        }
        // Dispatches: only from what the store actually has.
        const dispatches = intBetween(rand, 1, 4);
        for (let i = 0; i < dispatches; i += 1) {
            const stocked = materials.filter((m) => balance.get(m.id) >= m.default_pack_size);
            if (!stocked.length) break;
            const m = pick(rand, stocked);
            const maxPacks = Math.floor(balance.get(m.id) / m.default_pack_size);
            const packQty = intBetween(rand, 1, Math.min(maxPacks, 6));
            const qty = packQty * m.default_pack_size;
            balance.set(m.id, balance.get(m.id) - qty);
            plan.push({
                materialId: m.id,
                kind: 'dispatch',
                fromLocationId: store.id,
                toLocationId: pick(rand, destinations).id,
                qtyBase: qty,
                packSize: m.default_pack_size,
                packQty,
                reference: ref(),
                note: pick(rand, NOTES),
                occurredAt: new Date(dayStart + intBetween(rand, 13, 18) * 3_600_000 + intBetween(rand, 0, 59) * 60_000)
            });
        }
        // Occasional stock-take adjustment.
        if (rand() < 0.08) {
            const m = pick(rand, materials);
            const qty = intBetween(rand, 1, 25);
            const shrink = rand() < 0.7;
            if (shrink) balance.set(m.id, balance.get(m.id) - qty);
            else balance.set(m.id, balance.get(m.id) + qty);
            plan.push({
                materialId: m.id,
                kind: 'adjustment',
                fromLocationId: shrink ? store.id : null,
                toLocationId: shrink ? null : store.id,
                qtyBase: qty,
                reference: ref(),
                note: shrink ? 'Stock-take: shortfall written off' : 'Stock-take: found extra',
                occurredAt: new Date(dayStart + 19 * 3_600_000)
            });
        }
    }
    return plan;
}

async function seedDev({ orgId, reset }) {
    const rand = rng(20260908);

    console.log(`[seed:dev] org ${orgId}`);
    if (reset) await resetDevRows(orgId);
    else {
        const c = await alreadySeeded(orgId);
        if (c > 0) {
            console.log(`[seed:dev] ${c} dev movement(s) already present — pass --reset to regenerate.`);
            return;
        }
    }

    // Catalog: idempotent starter set (Central Store + the standard materials).
    await inv.seedDefaults(orgId);
    const materials = (await inv.listMaterials(orgId)).filter((m) => m.active);
    const locations = await ensureLocations(orgId);
    const vendors = await ensureVendors(orgId, materials);

    const store = locations.find((l) => l.kind === 'store' && l.active);
    if (!store) throw new Error('No active store location — cannot seed');
    const destinations = locations.filter((l) => l.kind !== 'store' && l.active);

    const plan = planMovements(rand, { materials, store, destinations, vendors });
    let inserted = 0;
    const insertedIds = [];
    for (const mv of plan) {
        const row = await inv.createMovement(orgId, mv, { createdBy: DEV_ACTOR });
        insertedIds.push(row.id);
        inserted += 1;
    }

    // Void a handful of dispatches so the "voided" state has something to show.
    let voided = 0;
    const dispatchIds = plan.map((mv, i) => (mv.kind === 'dispatch' ? insertedIds[i] : null)).filter(Boolean);
    for (const id of dispatchIds.filter(() => rand() < 0.05).slice(0, 4)) {
        await inv.voidMovement(orgId, id, { voidedBy: DEV_ACTOR, allowNegative: true });
        voided += 1;
    }

    const summary = await inv.getSummary(orgId);
    console.log(
        `[seed:dev] inserted ${inserted} movement(s), voided ${voided}; ` +
            `${summary.materials} materials · ${summary.locations} locations · ${summary.vendors} vendors · ` +
            `${summary.low_stock.length} below reorder`
    );
}

module.exports = { seedDev, DEV_REF_PREFIX };

if (require.main === module) {
    require('dotenv').config();
    const args = parseArgs(process.argv.slice(2));
    if (!useDatabase()) {
        console.error('[seed:dev] DATABASE_URL is not set');
        process.exit(1);
    }
    if (process.env.NODE_ENV === 'production' && !args.force) {
        console.error('[seed:dev] refusing to seed sample data with NODE_ENV=production (pass --force to override)');
        process.exit(1);
    }
    seedDev({ orgId: args.org, reset: args.reset })
        .then(() => closePool())
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[seed:dev] failed', err);
            process.exit(1);
        });
}
