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

// -- Locations -------------------------------------------------------------

async function listLocations(orgId, { includeInactive = false } = {}) {
    const pool = getPool();
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
                l.name AS location_name, l.kind AS location_kind
         FROM inventory_balances b
         JOIN inventory_materials m ON m.id = b.material_id AND m.org_id = b.org_id
         JOIN inventory_locations l ON l.id = b.location_id AND l.org_id = b.org_id
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

async function listMovements(orgId, { limit = 50, beforeId = null, materialId = null, locationId = null, kind = null } = {}) {
    const pool = getPool();
    const params = [orgId];
    const where = ['mv.org_id = $1'];
    if (materialId) {
        params.push(materialId);
        where.push(`mv.material_id = $${params.length}`);
    }
    if (locationId) {
        params.push(locationId);
        where.push(`(mv.from_location_id = $${params.length} OR mv.to_location_id = $${params.length})`);
    }
    if (kind) {
        params.push(kind);
        where.push(`mv.kind = $${params.length}`);
    }
    if (beforeId != null) {
        params.push(beforeId);
        where.push(`mv.id < $${params.length}`);
    }
    params.push(limit);
    const r = await pool.query(
        `SELECT mv.id, mv.kind, mv.material_id, mv.qty_base, mv.pack_size, mv.pack_qty,
                mv.vendor, mv.reference, mv.note, mv.occurred_at, mv.created_at,
                mv.created_by, mv.voided_at, mv.voided_by,
                mv.from_location_id, mv.to_location_id,
                m.name AS material_name, m.base_unit,
                fl.name AS from_location_name, tl.name AS to_location_name
         FROM inventory_movements mv
         JOIN inventory_materials m ON m.id = mv.material_id
         LEFT JOIN inventory_locations fl ON fl.id = mv.from_location_id
         LEFT JOIN inventory_locations tl ON tl.id = mv.to_location_id
         WHERE ${where.join(' AND ')}
         ORDER BY mv.id DESC
         LIMIT $${params.length}`,
        params
    );
    const rows = r.rows;
    const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;
    return { movements: rows, nextCursor };
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
 * Insert a movement. Runs in a transaction; for any outflow (a row with a
 * from_location_id, i.e. dispatch or negative adjustment) it locks the
 * material row and rejects a shortfall with status 409 unless
 * opts.allowNegative is set. Material and location existence are validated
 * here so callers get clean 404s instead of FK violations.
 *
 * @param {object} input material_id/kind/from/to/qty_base + optional pack/vendor/etc.
 * @param {object} [opts] { allowNegative, createdBy }
 */
async function createMovement(orgId, input, opts = {}) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

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

        // Negative-stock guard on the source location.
        if (input.fromLocationId && !opts.allowNegative) {
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
                 pack_size, pack_qty, vendor, reference, note, occurred_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, NOW()), $13)
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
                input.reference ?? null,
                input.note ?? null,
                input.occurredAt ?? null,
                opts.createdBy ?? null
            ]
        );
        await client.query('COMMIT');
        return getMovement(orgId, ins.rows[0].id);
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
async function getSummary(orgId) {
    const pool = getPool();
    const [materials, locations, movements, lowStock] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_materials WHERE org_id = $1 AND active = true`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_locations WHERE org_id = $1 AND active = true`, [orgId]),
        pool.query(`SELECT COUNT(*)::int AS c FROM inventory_movements WHERE org_id = $1 AND voided_at IS NULL`, [orgId]),
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
        movements: movements.rows[0].c,
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

module.exports = {
    seedDefaults,
    listMaterials,
    getMaterial,
    createMaterial,
    updateMaterial,
    listLocations,
    getLocation,
    createLocation,
    updateLocation,
    listBalances,
    getOnHand,
    listMovements,
    getMovement,
    createMovement,
    voidMovement,
    getSummary
};
