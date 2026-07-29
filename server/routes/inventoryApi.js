'use strict';

// Inventory tracker API. Mounted at /api/inventory from
// scripts/lis-nav-bot/server.js. Follows adminApi.js exactly: hand-rolled
// validation, { error } JSON bodies, 503 when DATABASE_URL is unset, and
// logAudit on every mutation.
//
// Auth model:
//   - reads (GET): any authenticated user (viewer included)
//   - movements + voids: super_admin | admin | operator (mirrors
//     requireRunStarter — the people who run jobs also move stock)
//   - catalog CRUD (materials/locations): super_admin | admin only, since a
//     bad catalog edit reshapes everyone's stock matrix
//
// org_id comes from the caller's JWT active_org_id (falling back to
// 'org-default' for legacy single-org / no-auth deploys), so tenants never
// touch each other's ledger.

const express = require('express');
const { useDatabase, getPool } = require('../db/pool');
const { requireAuth, requireRole } = require('../auth');
const { adminWriteLimiter } = require('../rateLimit');
const { logAudit } = require('../audit');
const inv = require('../db/inventory');

const router = express.Router();

router.use(requireAuth);

const requireMover = requireRole('super_admin', 'admin', 'operator');
const requireCatalogAdmin = requireRole('super_admin', 'admin');

const MOVEMENT_KINDS = new Set(['receipt', 'dispatch', 'adjustment']);
const LOCATION_KINDS = new Set(['store', 'business_unit', 'lab']);

function orgOf(req) {
    return (req.user && req.user.activeOrgId) || 'org-default';
}

function dbGuard(res) {
    if (!useDatabase()) {
        res.status(503).json({ error: 'Database not configured' });
        return false;
    }
    return true;
}

// Translate a thrown data-layer error (which may carry `status`) into a
// response, defaulting to 500. Keeps every catch block a one-liner.
function sendError(res, err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: (err && err.message) || String(err) });
}

function trimStr(v) {
    return v != null ? String(v).trim() : '';
}

// Parse an optional non-negative integer. Returns undefined when absent,
// throws a 400-tagged error when present but invalid.
function optInt(v, label, { min = 0, allowNull = false } = {}) {
    if (v === undefined) return undefined;
    if (v === null || v === '') {
        if (allowNull) return null;
        return undefined;
    }
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
        const err = new Error(`${label} must be an integer >= ${min}`);
        err.status = 400;
        throw err;
    }
    return n;
}

// -- Materials -------------------------------------------------------------

router.get('/materials', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
        const materials = await inv.listMaterials(orgOf(req), { includeInactive });
        res.json({ materials });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/materials', requireCatalogAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const body = req.body || {};
        const name = trimStr(body.name);
        if (!name) return res.status(400).json({ error: 'name is required' });
        const kind = body.metric_kind != null ? trimStr(body.metric_kind) : null;
        const fields = {
            name,
            sku: body.sku != null ? trimStr(body.sku) || null : null,
            metricKind: kind || null,
            baseUnit: trimStr(body.base_unit) || 'unit',
            defaultPackSize: optInt(body.default_pack_size, 'default_pack_size', { min: 1 }) ?? 1,
            defaultPackLabel: body.default_pack_label != null ? trimStr(body.default_pack_label) || null : null,
            reorderLevel: optInt(body.reorder_level, 'reorder_level', { min: 0 }) ?? 0
        };
        const material = await inv.createMaterial(orgOf(req), fields);
        await logAudit(req, {
            action: 'inventory.material.create',
            targetType: 'inventory_material',
            targetId: material.id,
            outcome: 'success',
            after: { name: material.name, metric_kind: material.metric_kind, base_unit: material.base_unit }
        });
        res.json({ material });
    } catch (err) {
        sendError(res, err);
    }
});

router.patch('/materials/:id', requireCatalogAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const orgId = orgOf(req);
        const before = await inv.getMaterial(orgId, req.params.id);
        if (!before) return res.status(404).json({ error: 'Material not found' });
        const body = req.body || {};
        const fields = {};
        if (body.name !== undefined) {
            const name = trimStr(body.name);
            if (!name) return res.status(400).json({ error: 'name cannot be empty' });
            fields.name = name;
        }
        if (body.sku !== undefined) fields.sku = trimStr(body.sku) || null;
        if (body.metric_kind !== undefined) fields.metricKind = trimStr(body.metric_kind) || null;
        if (body.base_unit !== undefined) fields.baseUnit = trimStr(body.base_unit) || 'unit';
        if (body.default_pack_size !== undefined) fields.defaultPackSize = optInt(body.default_pack_size, 'default_pack_size', { min: 1 }) ?? 1;
        if (body.default_pack_label !== undefined) fields.defaultPackLabel = trimStr(body.default_pack_label) || null;
        if (body.reorder_level !== undefined) fields.reorderLevel = optInt(body.reorder_level, 'reorder_level', { min: 0 }) ?? 0;
        if (typeof body.active === 'boolean') fields.active = body.active;
        const material = await inv.updateMaterial(orgId, req.params.id, fields);
        await logAudit(req, {
            action: 'inventory.material.update',
            targetType: 'inventory_material',
            targetId: req.params.id,
            outcome: 'success',
            before: { name: before.name, active: before.active, reorder_level: before.reorder_level },
            after: material ? { name: material.name, active: material.active, reorder_level: material.reorder_level } : null
        });
        res.json({ material });
    } catch (err) {
        sendError(res, err);
    }
});

// -- Locations -------------------------------------------------------------

router.get('/locations', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const includeInactive = req.query.include_inactive === '1' || req.query.include_inactive === 'true';
        const ensureBus = req.query.ensure_bus === '1' || req.query.ensure_bus === 'true';
        const locations = await inv.listLocations(orgOf(req), { includeInactive, ensureBus });
        res.json({ locations });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/locations', requireCatalogAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const body = req.body || {};
        const name = trimStr(body.name);
        if (!name) return res.status(400).json({ error: 'name is required' });
        const kind = trimStr(body.kind) || 'business_unit';
        if (!LOCATION_KINDS.has(kind)) {
            return res.status(400).json({ error: `kind must be one of: ${[...LOCATION_KINDS].join(', ')}` });
        }
        const fields = {
            name,
            kind,
            buCode: body.bu_code != null ? trimStr(body.bu_code) || null : null,
            clientCode: body.client_code != null ? trimStr(body.client_code) || null : null
        };
        const location = await inv.createLocation(orgOf(req), fields);
        await logAudit(req, {
            action: 'inventory.location.create',
            targetType: 'inventory_location',
            targetId: location.id,
            outcome: 'success',
            after: { name: location.name, kind: location.kind }
        });
        res.json({ location });
    } catch (err) {
        sendError(res, err);
    }
});

router.patch('/locations/:id', requireCatalogAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const orgId = orgOf(req);
        const before = await inv.getLocation(orgId, req.params.id);
        if (!before) return res.status(404).json({ error: 'Location not found' });
        const body = req.body || {};
        const fields = {};
        if (body.name !== undefined) {
            const name = trimStr(body.name);
            if (!name) return res.status(400).json({ error: 'name cannot be empty' });
            fields.name = name;
        }
        if (body.kind !== undefined) {
            const kind = trimStr(body.kind);
            if (!LOCATION_KINDS.has(kind)) {
                return res.status(400).json({ error: `kind must be one of: ${[...LOCATION_KINDS].join(', ')}` });
            }
            fields.kind = kind;
        }
        if (body.bu_code !== undefined) fields.buCode = trimStr(body.bu_code) || null;
        if (body.client_code !== undefined) fields.clientCode = trimStr(body.client_code) || null;
        if (typeof body.active === 'boolean') fields.active = body.active;
        const location = await inv.updateLocation(orgId, req.params.id, fields);
        await logAudit(req, {
            action: 'inventory.location.update',
            targetType: 'inventory_location',
            targetId: req.params.id,
            outcome: 'success',
            before: { name: before.name, kind: before.kind, active: before.active },
            after: location ? { name: location.name, kind: location.kind, active: location.active } : null
        });
        res.json({ location });
    } catch (err) {
        sendError(res, err);
    }
});

// -- Starter catalog -------------------------------------------------------
//
// One-click populate for a fresh org: a Central Store + the 12 standard
// materials. Idempotent, so it also tops up a partially-set-up org.
router.post('/seed-defaults', requireCatalogAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const result = await inv.seedDefaults(orgOf(req));
        await logAudit(req, {
            action: 'inventory.seed_defaults',
            outcome: 'success',
            metadata: result
        });
        res.json({ ok: true, ...result });
    } catch (err) {
        sendError(res, err);
    }
});

// -- Lab options -----------------------------------------------------------
//
// Flat client_locations list to populate the "lab" destination picker in the
// location editor. Distinct from /api/regions (a nested chip tree); here we
// just need code + label + BU so ops can attach an MCC code to a curated
// inventory location without importing every code automatically.
router.get('/lab-options', async (_req, res) => {
    if (!dbGuard(res)) return;
    try {
        const pool = getPool();
        const r = await pool.query(
            `SELECT code, name, business_unit_code, business_unit_name, city_label, state_label
             FROM client_locations
             WHERE active = true
             ORDER BY name NULLS LAST, code
             LIMIT 5000`
        );
        res.json({ labs: r.rows });
    } catch (err) {
        sendError(res, err);
    }
});

// -- Balances / summary ----------------------------------------------------

router.get('/balances', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const balances = await inv.listBalances(orgOf(req));
        res.json({ balances });
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/on-hand', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const materialId = trimStr(req.query.material_id);
        const locationId = trimStr(req.query.location_id);
        if (!materialId || !locationId) {
            return res.status(400).json({ error: 'material_id and location_id are required' });
        }
        const onHand = await inv.getOnHand(orgOf(req), materialId, locationId);
        res.json({ on_hand: onHand });
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/summary', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const summary = await inv.getSummary(orgOf(req));
        res.json({ summary });
    } catch (err) {
        sendError(res, err);
    }
});

// -- Movements -------------------------------------------------------------

router.get('/movements', async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const limitRaw = Number(req.query.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50;
        const beforeId = req.query.before_id != null && req.query.before_id !== '' ? Number(req.query.before_id) : null;
        const result = await inv.listMovements(orgOf(req), {
            limit,
            beforeId: Number.isFinite(beforeId) ? beforeId : null,
            materialId: trimStr(req.query.material_id) || null,
            locationId: trimStr(req.query.location_id) || null,
            kind: MOVEMENT_KINDS.has(trimStr(req.query.kind)) ? trimStr(req.query.kind) : null
        });
        res.json({ movements: result.movements, next_cursor: result.nextCursor });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/movements', requireMover, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const body = req.body || {};
        const kind = trimStr(body.kind);
        if (!MOVEMENT_KINDS.has(kind)) {
            return res.status(400).json({ error: `kind must be one of: ${[...MOVEMENT_KINDS].join(', ')}` });
        }
        const materialId = trimStr(body.material_id);
        if (!materialId) return res.status(400).json({ error: 'material_id is required' });

        const fromLocationId = trimStr(body.from_location_id) || null;
        const toLocationId = trimStr(body.to_location_id) || null;
        const toAllBus = body.to_all_bus === true || body.to_all_bus === 'true';

        // Direction rules per kind.
        if (kind === 'receipt') {
            if (!toLocationId) return res.status(400).json({ error: 'receipt requires to_location_id' });
            if (fromLocationId) return res.status(400).json({ error: 'receipt cannot have a from_location_id' });
        } else if (kind === 'dispatch') {
            if (toAllBus) {
                if (!fromLocationId) {
                    return res.status(400).json({ error: 'dispatch requires from_location_id' });
                }
                if (toLocationId) {
                    return res.status(400).json({ error: 'dispatch cannot set both to_location_id and to_all_bus' });
                }
            } else if (!fromLocationId || !toLocationId) {
                return res.status(400).json({ error: 'dispatch requires both from_location_id and to_location_id' });
            } else if (fromLocationId === toLocationId) {
                return res.status(400).json({ error: 'dispatch source and destination must differ' });
            }
        } else {
            // adjustment: exactly one side
            if ((fromLocationId && toLocationId) || (!fromLocationId && !toLocationId)) {
                return res.status(400).json({ error: 'adjustment requires exactly one of from_location_id or to_location_id' });
            }
        }

        // Quantity: explicit qty_base wins; otherwise derive from pack_size x pack_qty.
        const packSize = optInt(body.pack_size, 'pack_size', { min: 1, allowNull: true });
        const packQty = optInt(body.pack_qty, 'pack_qty', { min: 1, allowNull: true });
        let qtyBase = optInt(body.qty_base, 'qty_base', { min: 1 });
        if (qtyBase === undefined) {
            if (packSize && packQty) {
                qtyBase = packSize * packQty;
            } else {
                return res.status(400).json({ error: 'provide qty_base, or both pack_size and pack_qty' });
            }
        }

        let occurredAt = null;
        if (body.occurred_at != null && trimStr(body.occurred_at)) {
            const d = new Date(body.occurred_at);
            if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'occurred_at is not a valid date' });
            occurredAt = d.toISOString();
        }

        const input = {
            kind,
            materialId,
            fromLocationId,
            toLocationId,
            qtyBase,
            packSize: packSize ?? null,
            packQty: packQty ?? null,
            vendor: body.vendor != null ? trimStr(body.vendor) || null : null,
            reference: body.reference != null ? trimStr(body.reference) || null : null,
            note: body.note != null ? trimStr(body.note) || null : null,
            occurredAt
        };
        const allowNegative = body.allow_negative === true || body.allow_negative === 'true';
        if (kind === 'dispatch' && toAllBus) {
            const result = await inv.createDispatchToAllBus(orgOf(req), input, {
                allowNegative,
                createdBy: (req.user && req.user.id) || null
            });
            await logAudit(req, {
                action: 'inventory.movement.create',
                targetType: 'inventory_movement',
                targetId: result.movements.map((m) => String(m.id)).join(','),
                outcome: 'success',
                after: {
                    kind,
                    material_id: materialId,
                    from_location_id: fromLocationId,
                    to_all_bus: true,
                    qty_base: qtyBase,
                    destinations: result.destinations
                },
                metadata: allowNegative ? { allow_negative: true } : undefined
            });
            return res.json(result);
        }

        const movement = await inv.createMovement(orgOf(req), input, {
            allowNegative,
            createdBy: (req.user && req.user.id) || null
        });
        await logAudit(req, {
            action: 'inventory.movement.create',
            targetType: 'inventory_movement',
            targetId: String(movement.id),
            outcome: 'success',
            after: {
                kind,
                material_id: materialId,
                from_location_id: fromLocationId,
                to_location_id: toLocationId,
                qty_base: qtyBase
            },
            metadata: allowNegative ? { allow_negative: true } : undefined
        });
        res.json({ movement });
    } catch (err) {
        // A shortfall on dispatch is a client-correctable 409; still worth an
        // audit failure row so an override attempt trail exists.
        if (err && err.status === 409 && err.code === 'INSUFFICIENT_STOCK') {
            await logAudit(req, {
                action: 'inventory.movement.create',
                outcome: 'failure',
                targetType: 'inventory_movement',
                metadata: { reason: 'insufficient_stock', available: err.available }
            });
        }
        sendError(res, err);
    }
});

router.post('/movements/:id/void', requireMover, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const orgId = orgOf(req);
        const id = Number(req.params.id);
        if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid movement id' });
        const body = req.body || {};
        const allowNegative = body.allow_negative === true || body.allow_negative === 'true';
        const movement = await inv.voidMovement(orgId, id, {
            allowNegative,
            voidedBy: (req.user && req.user.id) || null
        });
        await logAudit(req, {
            action: 'inventory.movement.void',
            targetType: 'inventory_movement',
            targetId: String(id),
            outcome: 'success',
            metadata: allowNegative ? { allow_negative: true } : undefined
        });
        res.json({ movement });
    } catch (err) {
        sendError(res, err);
    }
});

module.exports = router;
