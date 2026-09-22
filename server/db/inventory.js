'use strict';

// Inventory data layer. Org-scoped queries over the three inventory tables and
// the inventory_balances view defined in server/db/migrate.js. The ledger
// (inventory_movements) is append-only; balances are always derived, so the
// only write that needs care is a dispatch/outflow, which runs in a
// transaction that locks the material row and refuses to overdraw a location.
//
// Every function takes an explicit orgId (the caller resolves it from the JWT's
// active_org_id, falling back to 'org-default') so tenants never see each
// other's stock. Callers hold the { error, status } contract: functions throw
// Errors carrying a numeric `status` for the router to translate into an HTTP
// code, defaulting to 500 for anything unexpected.

const crypto = require('crypto');
const { getPool } = require('./pool');
const { INVENTORY_MATERIAL_SEEDS } = require('./migrate');
const { fetchBusinessUnits } = require('../sync/listecLookups');

function httpError(message, status, extra) {
    const err = new Error(message);
    err.status = status;
    if (extra) Object.assign(err, extra);
    return err;
}

function newMaterialId() {
    return `invmat-${crypto.randomBytes(8).toString('hex')}`;
}

function newLocationId() {
    return `invloc-${crypto.randomBytes(8).toString('hex')}`;
}

function newVendorId() {
    return `invven-${crypto.randomBytes(8).toString('hex')}`;
}

// -- Materials -------------------------------------------------------------

async function listMaterials(orgId, { includeInactive = false } = {}) {
    const pool = getPool();
    const where = ['org_id = $1'];
    if (!includeInactive) where.push('active = true');
    const r = await pool.query(
        `SELECT id, org_id, name, sku, metric_kind, base_unit,
                default_pack_size, default_pack_label, reorder_level, active, created_at
         FROM inventory_materials
         WHERE ${where.join(' AND ')}
         ORDER BY name`,
        [orgId]
    );
    return r.rows;
}

async function getMaterial(orgId, id) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, org_id, name, sku, metric_kind, base_unit,
                default_pack_size, default_pack_label, reorder_level, active, created_at
         FROM inventory_materials
         WHERE org_id = $1 AND id = $2`,
        [orgId, id]
    );
    return r.rows[0] || null;
}

async function createMaterial(orgId, fields) {
    const pool = getPool();
    const id = newMaterialId();
    try {
        await pool.query(
            `INSERT INTO inventory_materials
                (id, org_id, name, sku, metric_kind, base_unit,
                 default_pack_size, default_pack_label, reorder_level, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
            [
                id,
                orgId,
                fields.name,
                fields.sku ?? null,
                fields.metricKind ?? null,
                fields.baseUnit || 'unit',
                fields.defaultPackSize ?? 1,
                fields.defaultPackLabel ?? null,
                fields.reorderLevel ?? 0
            ]
        );
    } catch (err) {
        if (err && err.code === '23505') {
            throw httpError(`A material named "${fields.name}" already exists`, 409);
        }
        throw err;
    }
    return getMaterial(orgId, id);
}

async function updateMaterial(orgId, id, fields) {
    const pool = getPool();
    const sets = [];
    const params = [orgId, id];
    const push = (col, val) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
    };
    if (fields.name !== undefined) push('name', fields.name);
    if (fields.sku !== undefined) push('sku', fields.sku);
    if (fields.metricKind !== undefined) push('metric_kind', fields.metricKind);
    if (fields.baseUnit !== undefined) push('base_unit', fields.baseUnit);
    if (fields.defaultPackSize !== undefined) push('default_pack_size', fields.defaultPackSize);
    if (fields.defaultPackLabel !== undefined) push('default_pack_label', fields.defaultPackLabel);
    if (fields.reorderLevel !== undefined) push('reorder_level', fields.reorderLevel);
    if (fields.active !== undefined) push('active', fields.active);
    if (!sets.length) return getMaterial(orgId, id);
    try {
        const r = await pool.query(
            `UPDATE inventory_materials SET ${sets.join(', ')}
             WHERE org_id = $1 AND id = $2 RETURNING id`,
            params
        );
        if (!r.rows.length) return null;
    } catch (err) {
        if (err && err.code === '23505') {
            throw httpError(`A material named "${fields.name}" already exists`, 409);
        }
        throw err;
    }
    return getMaterial(orgId, id);
}

// -- Vendors ---------------------------------------------------------------

// Each row carries a material_ids array aggregated from the join table so the
// UI can render the "supplies" chips and pre-select them on edit in one read.
async function listVendors(orgId, { includeInactive = false } = {}) {
    const pool = getPool();
    const where = ['v.org_id = $1'];
    if (!includeInactive) where.push('v.active = true');
    const r = await pool.query(
        `SELECT v.id, v.org_id, v.name, v.contact_person, v.phone, v.email,
                v.address, v.gst_number, v.note, v.active, v.created_at,
                COALESCE(
                    ARRAY_AGG(vm.material_id) FILTER (WHERE vm.material_id IS NOT NULL),
                    '{}'
                ) AS material_ids
         FROM inventory_vendors v
         LEFT JOIN inventory_vendor_materials vm ON vm.vendor_id = v.id
         WHERE ${where.join(' AND ')}
         GROUP BY v.id
         ORDER BY v.name`,
        [orgId]
    );
    return r.rows;
}

async function getVendor(orgId, id) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT v.id, v.org_id, v.name, v.contact_person, v.phone, v.email,
                v.address, v.gst_number, v.note, v.active, v.created_at,
                COALESCE(
                    ARRAY_AGG(vm.material_id) FILTER (WHERE vm.material_id IS NOT NULL),
                    '{}'
                ) AS material_ids
         FROM inventory_vendors v
         LEFT JOIN inventory_vendor_materials vm ON vm.vendor_id = v.id
         WHERE v.org_id = $1 AND v.id = $2
         GROUP BY v.id`,
        [orgId, id]
    );
    return r.rows[0] || null;
}

// Replace a vendor's material links with exactly the given set. Called inside
// the same transaction as an insert/update so the vendor and its links commit
// together. Only materials that belong to the org are linked, so a stale id
// from the client is silently ignored rather than corrupting the join table.
async function setVendorMaterials(client, orgId, vendorId, materialIds) {
    await client.query(`DELETE FROM inventory_vendor_materials WHERE vendor_id = $1`, [vendorId]);
    if (!Array.isArray(materialIds) || !materialIds.length) return;
    const unique = [...new Set(materialIds.map((m) => String(m)).filter(Boolean))];
    if (!unique.length) return;
    await client.query(
        `INSERT INTO inventory_vendor_materials (vendor_id, material_id)
         SELECT $1, m.id FROM inventory_materials m
         WHERE m.org_id = $2 AND m.id = ANY($3::text[])
         ON CONFLICT DO NOTHING`,
        [vendorId, orgId, unique]
    );
}

async function createVendor(orgId, fields) {
    const pool = getPool();
    const client = await pool.connect();
    const id = newVendorId();
    try {
        await client.query('BEGIN');
        await client.query(
            `INSERT INTO inventory_vendors
                (id, org_id, name, contact_person, phone, email, address, gst_number, note, active)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true)`,
            [
                id,
                orgId,
                fields.name,
                fields.contactPerson ?? null,
                fields.phone ?? null,
                fields.email ?? null,
                fields.address ?? null,
                fields.gstNumber ?? null,
                fields.note ?? null
            ]
        );
        if (fields.materialIds !== undefined) {
            await setVendorMaterials(client, orgId, id, fields.materialIds);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') {
            throw httpError(`A vendor named "${fields.name}" already exists`, 409);
        }
        throw err;
    } finally {
        client.release();
    }
    return getVendor(orgId, id);
}

async function updateVendor(orgId, id, fields) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const sets = [];
        const params = [orgId, id];
        const push = (col, val) => {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
        };
        if (fields.name !== undefined) push('name', fields.name);
        if (fields.contactPerson !== undefined) push('contact_person', fields.contactPerson);
        if (fields.phone !== undefined) push('phone', fields.phone);
        if (fields.email !== undefined) push('email', fields.email);
        if (fields.address !== undefined) push('address', fields.address);
        if (fields.gstNumber !== undefined) push('gst_number', fields.gstNumber);
        if (fields.note !== undefined) push('note', fields.note);
        if (fields.active !== undefined) push('active', fields.active);

        if (sets.length) {
            const r = await client.query(
                `UPDATE inventory_vendors SET ${sets.join(', ')}
                 WHERE org_id = $1 AND id = $2 RETURNING id`,
                params
            );
            if (!r.rows.length) {
                await client.query('ROLLBACK').catch(() => {});
                return null;
            }
        } else {
            const exists = await client.query(
                `SELECT id FROM inventory_vendors WHERE org_id = $1 AND id = $2`,
                [orgId, id]
            );
            if (!exists.rows.length) {
                await client.query('ROLLBACK').catch(() => {});
                return null;
            }
        }
        if (fields.materialIds !== undefined) {
            await setVendorMaterials(client, orgId, id, fields.materialIds);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        if (err && err.code === '23505') {
            throw httpError(`A vendor named "${fields.name}" already exists`, 409);
        }
        throw err;
    } finally {
        client.release();
    }
    return getVendor(orgId, id);
}

// -- Locations -------------------------------------------------------------

async function seedBusinessUnitLocations(client, orgId, units) {
    if (!Array.isArray(units) || !units.length) return 0;
    let added = 0;
    for (const row of units) {
        const code = String(row.code || row.id || '').trim();
        const name = String(row.name || row.label || code).trim();
        if (!name) continue;
        const linked = await client.query(
            `SELECT id FROM inventory_locations
             WHERE org_id = $1 AND active = true AND kind = 'business_unit'
               AND (bu_code = $2 OR LOWER(name) = LOWER($3))
             LIMIT 1`,
            [orgId, code || null, name]
        );
        if (linked.rows.length) continue;
        const ins = await client.query(
            `INSERT INTO inventory_locations (id, org_id, name, kind, bu_code, active)
             VALUES ($1, $2, $3, 'business_unit', $4, true)
             ON CONFLICT (org_id, name) DO NOTHING
             RETURNING id`,
            [newLocationId(), orgId, name, code || null]
        );
        if (ins.rowCount) added += 1;
    }
    return added;
}

async function syncBuLocationsFromListec(client, orgId, extraUnits = []) {
    /** @type {Map<string, string>} code -> display name */
    const bus = new Map();

    const fromLabs = await client.query(
        `SELECT DISTINCT business_unit_code AS code, business_unit_name AS name
         FROM client_locations
         WHERE active = true
           AND business_unit_code IS NOT NULL
           AND TRIM(business_unit_code) <> ''
         ORDER BY business_unit_name NULLS LAST, business_unit_code`
    );
    for (const row of fromLabs.rows) {
        const code = String(row.code).trim();
        const name = String(row.name || code).trim();
        if (code) bus.set(code, name);
    }

    // client_locations often has MCC rows without BU codes; fall back to the
    // same Listec lookups feed that powers GET /api/bu and the Tracer sidebar.
    const fromListec = await fetchBusinessUnits();
    for (const row of fromListec) {
        if (!bus.has(row.code)) bus.set(row.code, row.name);
    }
    for (const row of extraUnits) {
        const code = String(row.code || row.id || '').trim();
        const name = String(row.name || row.label || code).trim();
        if (name) bus.set(code || name, name);
    }

    await seedBusinessUnitLocations(
        client,
        orgId,
        [...bus.entries()].map(([code, name]) => ({ code, name }))
    );
}

async function listLocations(orgId, { includeInactive = false, ensureBus = false, extraUnits = [] } = {}) {
    const pool = getPool();
    if (ensureBus) {
        const client = await pool.connect();
        try {
            await syncBuLocationsFromListec(client, orgId, extraUnits);
        } finally {
            client.release();
        }
    }
    const where = ['org_id = $1'];
    if (!includeInactive) where.push('active = true');
    const r = await pool.query(
        `SELECT id, org_id, name, kind, bu_code, client_code, active, created_at
         FROM inventory_locations
         WHERE ${where.join(' AND ')}
         ORDER BY
            CASE kind WHEN 'store' THEN 0 WHEN 'business_unit' THEN 1 ELSE 2 END,
            name`,
        [orgId]
    );
    return r.rows;
}

async function getLocation(orgId, id) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, org_id, name, kind, bu_code, client_code, active, created_at
         FROM inventory_locations
         WHERE org_id = $1 AND id = $2`,
        [orgId, id]
    );
    return r.rows[0] || null;
}

async function createLocation(orgId, fields) {
    const pool = getPool();
    const id = newLocationId();
    try {
        await pool.query(
            `INSERT INTO inventory_locations
                (id, org_id, name, kind, bu_code, client_code, active)
             VALUES ($1, $2, $3, $4, $5, $6, true)`,
            [id, orgId, fields.name, fields.kind || 'business_unit', fields.buCode ?? null, fields.clientCode ?? null]
        );
    } catch (err) {
        if (err && err.code === '23505') {
            throw httpError(`A location named "${fields.name}" already exists`, 409);
        }
        throw err;
    }
    return getLocation(orgId, id);
}

async function updateLocation(orgId, id, fields) {
    const pool = getPool();
    const sets = [];
    const params = [orgId, id];
    const push = (col, val) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
    };
    if (fields.name !== undefined) push('name', fields.name);
    if (fields.kind !== undefined) push('kind', fields.kind);
    if (fields.buCode !== undefined) push('bu_code', fields.buCode);
    if (fields.clientCode !== undefined) push('client_code', fields.clientCode);
    if (fields.active !== undefined) push('active', fields.active);
    if (!sets.length) return getLocation(orgId, id);
    try {
        const r = await pool.query(
            `UPDATE inventory_locations SET ${sets.join(', ')}
             WHERE org_id = $1 AND id = $2 RETURNING id`,
            params
        );
        if (!r.rows.length) return null;
    } catch (err) {
        if (err && err.code === '23505') {
            throw httpError(`A location named "${fields.name}" already exists`, 409);
        }
        throw err;
    }
    return getLocation(orgId, id);
}

// -- Balances --------------------------------------------------------------

// Full material x location on-hand rows. The UI turns these into a matrix,
// filling absent (material, location) pairs with zero.
async function listBalances(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT b.material_id, b.location_id, b.on_hand,
                m.name AS material_name, m.base_unit, m.reorder_level, m.metric_kind,
                l.name AS location_name, l.kind AS location_kind,
                lm.created_at AS last_recorded_at,
                COALESCE(cu.display_name, cu.username, lm.created_by) AS last_recorded_by
         FROM inventory_balances b
         JOIN inventory_materials m ON m.id = b.material_id AND m.org_id = b.org_id
         JOIN inventory_locations l ON l.id = b.location_id AND l.org_id = b.org_id
         -- The newest live movement touching this cell: when the balance last
         -- changed and who keyed it in (super-admin stamp on the stock matrix).
         LEFT JOIN LATERAL (
             SELECT mv.created_at, mv.created_by
             FROM inventory_movements mv
             WHERE mv.org_id = b.org_id
               AND mv.material_id = b.material_id
               AND mv.voided_at IS NULL
               AND (mv.to_location_id = b.location_id OR mv.from_location_id = b.location_id)
             ORDER BY mv.created_at DESC, mv.id DESC
             LIMIT 1
         ) lm ON true
         LEFT JOIN users cu ON cu.id = lm.created_by
         WHERE b.org_id = $1
         ORDER BY m.name, l.name`,
        [orgId]
    );
    return r.rows;
}

// On-hand of one material at one location. Used by the dispatch form for live
// remaining-stock feedback and internally by the negative-stock guard.
async function onHandAt(client, orgId, materialId, locationId) {
    const r = await client.query(
        `SELECT COALESCE(
                    SUM(CASE WHEN to_location_id = $3 THEN qty_base ELSE 0 END)
                  - SUM(CASE WHEN from_location_id = $3 THEN qty_base ELSE 0 END),
                0)::bigint AS on_hand
         FROM inventory_movements
         WHERE org_id = $1 AND material_id = $2 AND voided_at IS NULL
           AND (from_location_id = $3 OR to_location_id = $3)`,
        [orgId, materialId, locationId]
    );
    return Number(r.rows[0].on_hand) || 0;
}

async function getOnHand(orgId, materialId, locationId) {
    const pool = getPool();
    return onHandAt(pool, orgId, materialId, locationId);
}

// -- Movements -------------------------------------------------------------

// Escape LIKE metacharacters so a user typing "50%" or "_" searches for the
// literal characters instead of turning into a wildcard.
function likePattern(q) {
    return `%${String(q).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

async function listMovements(
    orgId,
    {
        limit = 50,
        beforeId = null,
        materialId = null,
        locationId = null,
        locationDir = null,
        vendorId = null,
        createdBy = null,
        kind = null,
        q = null,
        from = null,
        to = null,
        includeVoided = true
    } = {}
) {
    const pool = getPool();
    const params = [orgId];
    const where = ['mv.org_id = $1'];
    if (materialId) {
        params.push(materialId);
        where.push(`mv.material_id = $${params.length}`);
    }
    // A location matches on either leg by default; locationDir narrows it to
    // the side the caller cares about ("what left this store" vs "what landed").
    if (locationId) {
        params.push(locationId);
        const n = params.length;
        where.push(
            locationDir === 'from'
                ? `mv.from_location_id = $${n}`
                : locationDir === 'to'
                  ? `mv.to_location_id = $${n}`
                  : `(mv.from_location_id = $${n} OR mv.to_location_id = $${n})`
        );
    }
    if (vendorId) {
        params.push(vendorId);
        where.push(`mv.vendor_id = $${params.length}`);
    }
    if (createdBy) {
        params.push(createdBy);
        where.push(`mv.created_by = $${params.length}`);
    }
    if (kind) {
        params.push(kind);
        where.push(`mv.kind = $${params.length}`);
    }
    // Free-text search across everything a person might remember about a
    // movement: what moved, where, who supplied it, the invoice number, the
    // note, or who recorded it.
    if (q) {
        params.push(likePattern(q));
        const n = params.length;
        where.push(
            `(m.name ILIKE $${n} OR mv.reference ILIKE $${n} OR mv.note ILIKE $${n}
              OR mv.vendor ILIKE $${n} OR v.name ILIKE $${n}
              OR fl.name ILIKE $${n} OR tl.name ILIKE $${n} OR mv.created_by ILIKE $${n})`
        );
    }
    // Half-open window: callers pass `to` as the start of the day *after* the
    // last day they want, so a range is inclusive of whole local days.
    if (from) {
        params.push(from);
        where.push(`mv.occurred_at >= $${params.length}`);
    }
    if (to) {
        params.push(to);
        where.push(`mv.occurred_at < $${params.length}`);
    }
    if (!includeVoided) {
        where.push('mv.voided_at IS NULL');
    }
    if (beforeId != null) {
        params.push(beforeId);
        where.push(`mv.id < $${params.length}`);
    }
    params.push(limit);
    // COUNT(*) OVER() gives the size of the whole filtered set alongside this
    // page, so the UI can say "50 of 312" without a second round trip.
    const r = await pool.query(
        `SELECT mv.id, mv.kind, mv.material_id, mv.qty_base, mv.pack_size, mv.pack_qty,
                mv.vendor, mv.vendor_id, mv.reference, mv.note, mv.photo_path,
                mv.occurred_at, mv.created_at,
                mv.created_by, mv.voided_at, mv.voided_by,
                mv.from_location_id, mv.to_location_id,
                m.name AS material_name, m.base_unit,
                fl.name AS from_location_name, tl.name AS to_location_name,
                v.name AS vendor_name,
                COALESCE(cu.display_name, cu.username) AS created_by_name,
                COUNT(*) OVER()::int AS total_count
         FROM inventory_movements mv
         JOIN inventory_materials m ON m.id = mv.material_id
         LEFT JOIN inventory_locations fl ON fl.id = mv.from_location_id
         LEFT JOIN inventory_locations tl ON tl.id = mv.to_location_id
         LEFT JOIN inventory_vendors v ON v.id = mv.vendor_id
         LEFT JOIN users cu ON cu.id = mv.created_by
         WHERE ${where.join(' AND ')}
         ORDER BY mv.id DESC
         LIMIT $${params.length}`,
        params
    );
    const total = r.rows.length ? r.rows[0].total_count : 0;
    const rows = r.rows.map(({ total_count, ...row }) => row);
    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
    return { movements: rows, nextCursor, total };
}

/**
 * Everyone who has ever recorded a movement in this org, for the ledger's
 * "recorded by" filter. Built from the ledger itself rather than the user
 * directory, so the list only offers picks that can return rows and a
 * since-deleted account still shows up (by id) instead of vanishing.
 */
async function listMovementUsers(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT mv.created_by AS id,
                COALESCE(NULLIF(u.display_name, ''), u.username, mv.created_by) AS name,
                COUNT(*)::int AS movements
         FROM inventory_movements mv
         LEFT JOIN users u ON u.id = mv.created_by
         WHERE mv.org_id = $1 AND mv.created_by IS NOT NULL AND mv.created_by <> ''
         GROUP BY mv.created_by, u.display_name, u.username
         ORDER BY name ASC`,
        [orgId]
    );
    return r.rows;
}

async function getMovement(orgId, id) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT * FROM inventory_movements WHERE org_id = $1 AND id = $2`,
        [orgId, id]
    );
    return r.rows[0] || null;
}

/**
 * Insert a movement. Runs in a transaction; for a dispatch outflow it locks
 * the material row and rejects a shortfall with status 409 unless
 * opts.allowNegative is set. Adjustments are exempt from the guard — they
 * exist to correct the ledger, so they may take a location negative.
 * Material and location existence are validated here so callers get clean
 * 404s instead of FK violations.
 *
 * @param {object} input material_id/kind/from/to/qty_base + optional pack/vendor/etc.
 * @param {object} [opts] { allowNegative, createdBy }
 */
// Core insert used by createMovement and createMovementsBatch. Assumes the
// caller owns the transaction (client is mid-BEGIN). Locks the material,
// validates locations/vendor, guards against overdraw on the source, then
// inserts one row and returns its id. Because it reads on-hand from within the
// same transaction, sequential lines in a batch see each other's inserts.
async function insertMovementTx(client, orgId, input, opts = {}) {
    // Lock the material row so concurrent movements of the same material
    // serialise — otherwise two dispatches could both read stale stock.
    const mat = await client.query(
        `SELECT id FROM inventory_materials WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, input.materialId]
    );
    if (!mat.rows.length) throw httpError('Unknown material', 404);

    // Validate referenced locations belong to this org.
    for (const locId of [input.fromLocationId, input.toLocationId]) {
        if (!locId) continue;
        const loc = await client.query(
            `SELECT id FROM inventory_locations WHERE org_id = $1 AND id = $2`,
            [orgId, locId]
        );
        if (!loc.rows.length) throw httpError('Unknown location', 404);
    }

    // Validate the vendor (if any) belongs to this org, mirroring locations.
    if (input.vendorId) {
        const ven = await client.query(
            `SELECT id FROM inventory_vendors WHERE org_id = $1 AND id = $2`,
            [orgId, input.vendorId]
        );
        if (!ven.rows.length) throw httpError('Unknown vendor', 404);
    }

    // Negative-stock guard on the source location. Adjustments are exempt:
    // correcting the ledger must never be blocked by the ledger.
    if (input.fromLocationId && input.kind !== 'adjustment' && !opts.allowNegative) {
        const available = await onHandAt(client, orgId, input.materialId, input.fromLocationId);
        if (available < input.qtyBase) {
            throw httpError(
                `Insufficient stock: ${available} on hand, ${input.qtyBase} requested`,
                409,
                { code: 'INSUFFICIENT_STOCK', available }
            );
        }
    }

    const ins = await client.query(
        `INSERT INTO inventory_movements
            (org_id, material_id, kind, from_location_id, to_location_id, qty_base,
             pack_size, pack_qty, vendor, vendor_id, reference, note, photo_path, occurred_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14, NOW()), $15)
         RETURNING id`,
        [
            orgId,
            input.materialId,
            input.kind,
            input.fromLocationId ?? null,
            input.toLocationId ?? null,
            input.qtyBase,
            input.packSize ?? null,
            input.packQty ?? null,
            input.vendor ?? null,
            input.vendorId ?? null,
            input.reference ?? null,
            input.note ?? null,
            input.photoPath ?? null,
            input.occurredAt ?? null,
            opts.createdBy ?? null
        ]
    );
    return ins.rows[0].id;
}

async function createMovement(orgId, input, opts = {}) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const id = await insertMovementTx(client, orgId, input, opts);
        await client.query('COMMIT');
        return getMovement(orgId, id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Ensure inventory_locations rows exist for every distinct Listec business unit,
 * then return active BU/lab destination ids (excluding the dispatch source).
 */
async function resolveBuLabDestinationIds(client, orgId, fromLocationId) {
    await syncBuLocationsFromListec(client, orgId);

    const r = await client.query(
        `SELECT id, name FROM inventory_locations
         WHERE org_id = $1 AND active = true
           AND kind IN ('business_unit', 'lab')
           AND id <> $2
         ORDER BY name`,
        [orgId, fromLocationId]
    );
    return r.rows;
}

/**
 * Fan a single dispatch quantity out to every BU/lab destination. Runs in one
 * transaction and checks total draw (qty × destinations) against source stock.
 */
// Fan one dispatch line out to every BU/lab destination, within a transaction
// the caller owns. Returns the inserted ids plus the destination rows so the
// caller can report names. Checks total draw (qty × destinations) up front.
async function insertDispatchAllBusTx(client, orgId, input, opts = {}) {
    const mat = await client.query(
        `SELECT id FROM inventory_materials WHERE org_id = $1 AND id = $2 FOR UPDATE`,
        [orgId, input.materialId]
    );
    if (!mat.rows.length) throw httpError('Unknown material', 404);

    const fromLoc = await client.query(
        `SELECT id FROM inventory_locations WHERE org_id = $1 AND id = $2`,
        [orgId, input.fromLocationId]
    );
    if (!fromLoc.rows.length) throw httpError('Unknown location', 404);

    const destinations = await resolveBuLabDestinationIds(client, orgId, input.fromLocationId);
    if (!destinations.length) {
        throw httpError(
            'No business units or labs found. Sync client locations or add BU/lab destinations in Catalog.',
            400
        );
    }

    const totalQty = input.qtyBase * destinations.length;
    if (!opts.allowNegative) {
        const available = await onHandAt(client, orgId, input.materialId, input.fromLocationId);
        if (available < totalQty) {
            throw httpError(
                `Insufficient stock: ${available} on hand, ${totalQty} requested (${input.qtyBase} × ${destinations.length} destinations)`,
                409,
                { code: 'INSUFFICIENT_STOCK', available, destinations: destinations.length }
            );
        }
    }

    const ids = [];
    for (const dest of destinations) {
        const ins = await client.query(
            `INSERT INTO inventory_movements
                (org_id, material_id, kind, from_location_id, to_location_id, qty_base,
                 pack_size, pack_qty, vendor, vendor_id, reference, note, photo_path, occurred_at, created_by)
             VALUES ($1, $2, 'dispatch', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, COALESCE($13, NOW()), $14)
             RETURNING id`,
            [
                orgId,
                input.materialId,
                input.fromLocationId,
                dest.id,
                input.qtyBase,
                input.packSize ?? null,
                input.packQty ?? null,
                input.vendor ?? null,
                input.vendorId ?? null,
                input.reference ?? null,
                input.note ?? null,
                input.photoPath ?? null,
                input.occurredAt ?? null,
                opts.createdBy ?? null
            ]
        );
        ids.push(ins.rows[0].id);
    }
    return { ids, destinations };
}

async function createDispatchToAllBus(orgId, input, opts = {}) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { ids, destinations } = await insertDispatchAllBusTx(client, orgId, input, opts);
        await client.query('COMMIT');
        const movements = [];
        for (const id of ids) {
            movements.push(await getMovement(orgId, id));
        }
        return {
            movements,
            destinations: destinations.length,
            qty_per_destination: input.qtyBase,
            destination_names: destinations.map((d) => d.name)
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Record a whole order — several material lines sharing one header — in a single
 * transaction, so an overdraw or bad line rolls the entire order back. Used by
 * the Receive (vendor + destination) and Dispatch (from + to / all-BUs) forms.
 *
 * @param {object} header { kind, vendorId?, fromLocationId?, toLocationId?, toAllBus?, reference?, note?, occurredAt? }
 * @param {Array}  lines  [{ materialId, qtyBase, packSize?, packQty?, photoPath? }]
 * @param {object} [opts] { allowNegative, createdBy }
 */
async function createMovementsBatch(orgId, header, lines, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) {
        throw httpError('At least one line is required', 400);
    }
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const movementIds = [];
        let destinationNames = [];
        for (const line of lines) {
            const input = {
                kind: header.kind,
                materialId: line.materialId,
                fromLocationId: header.fromLocationId ?? null,
                toLocationId: header.toLocationId ?? null,
                qtyBase: line.qtyBase,
                packSize: line.packSize ?? null,
                packQty: line.packQty ?? null,
                vendor: header.vendor ?? null,
                vendorId: header.vendorId ?? null,
                reference: header.reference ?? null,
                note: header.note ?? null,
                photoPath: line.photoPath ?? null,
                occurredAt: header.occurredAt ?? null
            };
            if (header.kind === 'dispatch' && header.toAllBus) {
                const { ids, destinations } = await insertDispatchAllBusTx(client, orgId, input, opts);
                movementIds.push(...ids);
                destinationNames = destinations.map((d) => d.name);
            } else {
                const id = await insertMovementTx(client, orgId, input, opts);
                movementIds.push(id);
            }
        }
        // Receiving from a purchase order: link every movement back to the
        // order and close it, all inside the same transaction as the stock.
        if (header.orderId) {
            const ord = await client.query(
                `SELECT id, status FROM inventory_orders WHERE org_id = $1 AND id = $2 FOR UPDATE`,
                [orgId, header.orderId]
            );
            if (!ord.rows.length) throw httpError('Order not found', 404);
            if (ord.rows[0].status !== 'placed') {
                throw httpError(`Order is already ${ord.rows[0].status}`, 409);
            }
            await client.query(`UPDATE inventory_movements SET order_id = $1 WHERE id = ANY($2::bigint[])`, [
                header.orderId,
                movementIds
            ]);
            await client.query(
                `UPDATE inventory_orders
                 SET status = 'received', received_at = NOW(), received_by = $3
                 WHERE org_id = $1 AND id = $2`,
                [orgId, header.orderId, opts.createdBy ?? null]
            );
        }
        await client.query('COMMIT');
        const movements = [];
        for (const id of movementIds) {
            movements.push(await getMovement(orgId, id));
        }
        return {
            movements,
            lines: lines.length,
            destination_names: destinationNames.length ? destinationNames : undefined
        };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Void a movement (soft-delete). Reversing an inflow can push a downstream
 * location negative if the stock was already dispatched onward, so the same
 * guard applies: voiding a to_location inflow is rejected with 409 when it
 * would overdraw that location, unless opts.allowNegative is set.
 */
async function voidMovement(orgId, id, opts = {}) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const cur = await client.query(
            `SELECT id, material_id, from_location_id, to_location_id, qty_base, voided_at
             FROM inventory_movements
             WHERE org_id = $1 AND id = $2 FOR UPDATE`,
            [orgId, id]
        );
        if (!cur.rows.length) throw httpError('Movement not found', 404);
        const row = cur.rows[0];
        if (row.voided_at) throw httpError('Movement is already voided', 409);

        // Lock the material to serialise against concurrent movements.
        await client.query(
            `SELECT id FROM inventory_materials WHERE org_id = $1 AND id = $2 FOR UPDATE`,
            [orgId, row.material_id]
        );

        // Removing an inflow reduces stock at the destination — make sure that
        // destination can absorb the reduction without going negative.
        if (row.to_location_id && !opts.allowNegative) {
            const available = await onHandAt(client, orgId, row.material_id, row.to_location_id);
            if (available < row.qty_base) {
                throw httpError(
                    `Cannot void: only ${available} on hand at destination, this movement added ${row.qty_base}. Stock was moved onward first.`,
                    409,
                    { code: 'INSUFFICIENT_STOCK', available }
                );
            }
        }

        await client.query(
            `UPDATE inventory_movements
             SET voided_at = NOW(), voided_by = $3
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, opts.voidedBy ?? null]
        );
        await client.query('COMMIT');
        return getMovement(orgId, id);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

// -- Summary ---------------------------------------------------------------

// Headline counts plus a low-stock list. Low stock is judged on central-store
// on-hand (kind='store') vs. the material's reorder_level, since the store is
// what ops reorders against; per-BU shortfalls surface in the Stock matrix.
// -- Purchase orders -------------------------------------------------------

function newOrderId() {
    return `invord-${crypto.randomBytes(8).toString('hex')}`;
}

const ORDER_STATUSES = new Set(['placed', 'received', 'cancelled']);

// DATE columns come back as local-midnight JS Dates from node-postgres, which
// shift a day depending on the server's timezone; select them as text.
const ORDER_SELECT = `
    SELECT o.id, o.org_id, o.vendor_id, o.reference,
           to_char(o.ordered_on, 'YYYY-MM-DD')  AS ordered_on,
           to_char(o.expected_on, 'YYYY-MM-DD') AS expected_on,
           o.direct_dispatch, o.destination_location_id, o.status,
           o.pi_path, o.pi_name, o.note, o.created_at, o.created_by,
           o.received_at, o.received_by, o.cancelled_at, o.cancelled_by,
           v.name AS vendor_name,
           l.name AS destination_name, l.kind AS destination_kind,
           COALESCE(cu.display_name, cu.username) AS created_by_name,
           COALESCE((
               SELECT json_agg(json_build_object(
                   'id', ol.id,
                   'material_id', ol.material_id,
                   'material_name', m.name,
                   'base_unit', m.base_unit,
                   'pack_size', ol.pack_size,
                   'pack_qty', ol.pack_qty,
                   'qty_base', ol.qty_base
               ) ORDER BY ol.position, ol.id)
               FROM inventory_order_lines ol
               JOIN inventory_materials m ON m.id = ol.material_id
               WHERE ol.order_id = o.id
           ), '[]'::json) AS lines,
           (SELECT COUNT(*)::int FROM inventory_movements mv
             WHERE mv.order_id = o.id AND mv.voided_at IS NULL) AS receipt_count
    FROM inventory_orders o
    LEFT JOIN inventory_vendors v ON v.id = o.vendor_id
    LEFT JOIN inventory_locations l ON l.id = o.destination_location_id
    LEFT JOIN users cu ON cu.id = o.created_by`;

async function listOrders(orgId, { status = null, limit = 500 } = {}) {
    const pool = getPool();
    const params = [orgId];
    let where = 'WHERE o.org_id = $1';
    if (status && ORDER_STATUSES.has(status)) {
        params.push(status);
        where += ` AND o.status = $${params.length}`;
    }
    params.push(limit);
    const r = await pool.query(
        `${ORDER_SELECT}
         ${where}
         ORDER BY (o.status = 'placed') DESC, o.expected_on ASC NULLS LAST, o.ordered_on DESC, o.created_at DESC
         LIMIT $${params.length}`,
        params
    );
    return r.rows;
}

async function getOrder(orgId, id) {
    const pool = getPool();
    const r = await pool.query(`${ORDER_SELECT} WHERE o.org_id = $1 AND o.id = $2`, [orgId, id]);
    return r.rows[0] || null;
}

/**
 * @param {string} orgId
 * @param {{ vendorId: string, reference?: string|null, orderedOn: string, expectedOn?: string|null,
 *           directDispatch?: boolean, destinationLocationId?: string|null, note?: string|null,
 *           piPath?: string|null, piName?: string|null }} header
 * @param {{ materialId: string, packSize: number, packQty: number }[]} lines
 */
async function createOrder(orgId, header, lines, opts = {}) {
    if (!Array.isArray(lines) || !lines.length) throw httpError('At least one line is required', 400);
    const pool = getPool();
    const client = await pool.connect();
    const id = newOrderId();
    try {
        await client.query('BEGIN');
        const ven = await client.query(`SELECT id FROM inventory_vendors WHERE org_id = $1 AND id = $2`, [
            orgId,
            header.vendorId
        ]);
        if (!ven.rows.length) throw httpError('Unknown vendor', 404);
        if (header.destinationLocationId) {
            const loc = await client.query(`SELECT id FROM inventory_locations WHERE org_id = $1 AND id = $2`, [
                orgId,
                header.destinationLocationId
            ]);
            if (!loc.rows.length) throw httpError('Unknown destination location', 404);
        }
        await client.query(
            `INSERT INTO inventory_orders
                (id, org_id, vendor_id, reference, ordered_on, expected_on, direct_dispatch,
                 destination_location_id, note, pi_path, pi_name, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [
                id,
                orgId,
                header.vendorId,
                header.reference ?? null,
                header.orderedOn,
                header.expectedOn ?? null,
                header.directDispatch === true,
                header.destinationLocationId ?? null,
                header.note ?? null,
                header.piPath ?? null,
                header.piName ?? null,
                opts.createdBy ?? null
            ]
        );
        let position = 0;
        for (const line of lines) {
            const mat = await client.query(`SELECT id FROM inventory_materials WHERE org_id = $1 AND id = $2`, [
                orgId,
                line.materialId
            ]);
            if (!mat.rows.length) throw httpError('Unknown material', 404);
            const packSize = Math.max(1, Number(line.packSize) || 1);
            const packQty = Number(line.packQty);
            if (!Number.isFinite(packQty) || packQty < 1) throw httpError('Each line needs a pack count of 1 or more', 400);
            await client.query(
                `INSERT INTO inventory_order_lines (order_id, material_id, pack_size, pack_qty, qty_base, position)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [id, line.materialId, packSize, packQty, packSize * packQty, position++]
            );
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return getOrder(orgId, id);
}

const ORDER_EDITABLE = {
    reference: 'reference',
    expectedOn: 'expected_on',
    directDispatch: 'direct_dispatch',
    destinationLocationId: 'destination_location_id',
    note: 'note',
    piPath: 'pi_path',
    piName: 'pi_name'
};

/**
 * Patch header fields and/or move status. placed -> received | cancelled;
 * cancelled -> placed (reopen). A received order is closed for good — its
 * stock is in the ledger; correct that there.
 */
async function updateOrder(orgId, id, fields, opts = {}) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const cur = await client.query(`SELECT id, status FROM inventory_orders WHERE org_id = $1 AND id = $2 FOR UPDATE`, [
            orgId,
            id
        ]);
        if (!cur.rows.length) throw httpError('Order not found', 404);
        const current = cur.rows[0].status;
        const sets = [];
        const params = [orgId, id];
        const push = (col, val) => {
            params.push(val);
            sets.push(`${col} = $${params.length}`);
        };
        for (const [key, col] of Object.entries(ORDER_EDITABLE)) {
            if (fields[key] !== undefined) push(col, fields[key]);
        }
        if (fields.destinationLocationId) {
            const loc = await client.query(`SELECT id FROM inventory_locations WHERE org_id = $1 AND id = $2`, [
                orgId,
                fields.destinationLocationId
            ]);
            if (!loc.rows.length) throw httpError('Unknown destination location', 404);
        }
        if (fields.status !== undefined && fields.status !== current) {
            if (!ORDER_STATUSES.has(fields.status)) throw httpError('Unknown status', 400);
            if (current === 'received') throw httpError('A received order cannot change status', 409);
            if (fields.status === 'received') {
                // Manual close without stock — allowed, but recorded as such.
                push('received_at', new Date());
                push('received_by', opts.actorId ?? null);
            } else if (fields.status === 'cancelled') {
                push('cancelled_at', new Date());
                push('cancelled_by', opts.actorId ?? null);
            } else if (fields.status === 'placed') {
                push('cancelled_at', null);
                push('cancelled_by', null);
            }
            push('status', fields.status);
        }
        if (sets.length) {
            await client.query(`UPDATE inventory_orders SET ${sets.join(', ')} WHERE org_id = $1 AND id = $2`, params);
        }
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
    return getOrder(orgId, id);
}

async function getSummary(orgId) {
    const pool = getPool();
    const [materials, locations, vendors, movements, voided, lowStock] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_materials WHERE org_id = $1 AND active = true`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_locations WHERE org_id = $1 AND active = true`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_vendors WHERE org_id = $1 AND active = true`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_movements WHERE org_id = $1 AND voided_at IS NULL`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_movements WHERE org_id = $1 AND voided_at IS NOT NULL`, [orgId]),
        pool.query(
            `SELECT m.id AS material_id, m.name, m.base_unit, m.reorder_level,
                    COALESCE(SUM(CASE WHEN l.kind = 'store' THEN b.on_hand ELSE 0 END), 0)::bigint AS store_on_hand
             FROM inventory_materials m
             LEFT JOIN inventory_balances b
               ON b.material_id = m.id AND b.org_id = m.org_id
             LEFT JOIN inventory_locations l
               ON l.id = b.location_id AND l.org_id = b.org_id
             WHERE m.org_id = $1 AND m.active = true AND m.reorder_level > 0
             GROUP BY m.id, m.name, m.base_unit, m.reorder_level
             HAVING COALESCE(SUM(CASE WHEN l.kind = 'store' THEN b.on_hand ELSE 0 END), 0) < m.reorder_level
             ORDER BY m.name`,
            [orgId]
        )
    ]);
    return {
        materials: materials.rows[0].c,
        locations: locations.rows[0].c,
        vendors: vendors.rows[0].c,
        movements: movements.rows[0].c,
        // Voided rows stay in the ledger but are excluded from every balance;
        // the figures strip says so rather than leaving the reader to wonder
        // why the ledger is longer than the entry count.
        movements_voided: voided.rows[0].c,
        low_stock: lowStock.rows
    };
}

// -- Starter catalog -------------------------------------------------------

// Seed a Central Store plus the 12 standard materials into an arbitrary org.
// Reuses the same seed list migrate.js applies to org-default so a brand-new
// tenant can be populated with one click. Idempotent via ON CONFLICT, so it
// safely tops up an org that already has some of the catalog.
async function seedDefaults(orgId) {
    const pool = getPool();
    const store = await pool.query(
        `INSERT INTO inventory_locations (id, org_id, name, kind)
         VALUES ($1, $2, 'Central Store', 'store')
         ON CONFLICT (org_id, name) DO NOTHING`,
        [newLocationId(), orgId]
    );
    let materialsAdded = 0;
    for (const m of INVENTORY_MATERIAL_SEEDS) {
        const r = await pool.query(
            `INSERT INTO inventory_materials
                (id, org_id, name, metric_kind, base_unit, default_pack_size, default_pack_label)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (org_id, name) DO NOTHING`,
            [newMaterialId(), orgId, m.name, m.metricKind, m.baseUnit, m.packSize, m.packLabel]
        );
        materialsAdded += r.rowCount || 0;
    }
    return { locationsAdded: store.rowCount || 0, materialsAdded };
}

// -- Consumption (super admin dashboard) -----------------------------------

// Month buckets are cut in the lab's local timezone. The UI stores
// occurred_at at local noon, so any nearby zone lands in the same month.
const CONSUMPTION_TZ = 'Asia/Kolkata';

// ['YYYY-MM', ...] oldest → newest, n months ending with the current one.
function monthKeysEnding(n, tz) {
    const now = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit' }).format(new Date());
    let [y, m] = now.split('-').map(Number);
    const out = [];
    for (let i = 0; i < n; i++) {
        out.unshift(`${y}-${String(m).padStart(2, '0')}`);
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
    }
    return out;
}

/**
 * Units dispatched into each business unit / lab, per material, per calendar
 * month, for the last `months` months (current month included). Voided rows
 * are excluded. One row per (location, material, month) with any activity;
 * the caller fills the zeros.
 */
async function listConsumption(orgId, { months = 12 } = {}) {
    const pool = getPool();
    const n = Math.min(Math.max(1, Math.floor(months)), 36);
    const keys = monthKeysEnding(n, CONSUMPTION_TZ);
    const r = await pool.query(
        `SELECT mv.to_location_id AS location_id, mv.material_id,
                to_char(date_trunc('month', mv.occurred_at AT TIME ZONE $3), 'YYYY-MM') AS month,
                SUM(mv.qty_base)::int AS qty,
                COUNT(*)::int AS movements
         FROM inventory_movements mv
         JOIN inventory_locations l ON l.id = mv.to_location_id
         WHERE mv.org_id = $1
           AND mv.kind = 'dispatch'
           AND mv.voided_at IS NULL
           AND l.kind IN ('business_unit', 'lab')
           AND (mv.occurred_at AT TIME ZONE $3) >= $2::timestamp
         GROUP BY 1, 2, 3
         ORDER BY 3, 1, 2`,
        [orgId, `${keys[0]}-01`, CONSUMPTION_TZ]
    );
    return { months: keys, rows: r.rows };
}

module.exports = {
    seedDefaults,
    listConsumption,
    listMaterials,
    getMaterial,
    createMaterial,
    updateMaterial,
    listVendors,
    getVendor,
    createVendor,
    updateVendor,
    listLocations,
    getLocation,
    createLocation,
    updateLocation,
    listBalances,
    getOnHand,
    listMovements,
    listMovementUsers,
    getMovement,
    createMovement,
    createMovementsBatch,
    createDispatchToAllBus,
    voidMovement,
    listOrders,
    getOrder,
    createOrder,
    updateOrder,
    getSummary
};
