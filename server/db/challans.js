'use strict';

// Dispatch challans (delivery slips for the courier) and their running
// numbers. A dispatch "batch" is every live dispatch movement saved in one
// transaction: same org, source, destination and created_at. A challan is
// created the first time someone prints one for a batch; later prints return
// the same number and may update the transport details.

const { getPool } = require('./pool');

function httpError(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}

const DETAIL_KEYS = ['party_address', 'party_licence', 'transport', 'gr_no', 'vehicle_no', 'station', 'eway_bill'];

function cleanDetails(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    for (const k of DETAIL_KEYS) {
        if (raw[k] == null) continue;
        const v = String(raw[k]).trim().slice(0, 500);
        if (v) out[k] = v;
    }
    return out;
}

async function loadBatch(client, orgId, movementId) {
    const seed = await client.query(
        `SELECT id, kind, from_location_id, to_location_id, created_at
         FROM inventory_movements
         WHERE org_id = $1 AND id = $2 AND voided_at IS NULL`,
        [orgId, movementId]
    );
    if (!seed.rows.length) throw httpError('Dispatch not found (or voided)', 404);
    const s = seed.rows[0];
    if (s.kind !== 'dispatch') throw httpError('Challans are for dispatches only', 400);
    const r = await client.query(
        `SELECT mv.id, mv.qty_base, mv.pack_size, mv.pack_qty, mv.reference, mv.note, mv.occurred_at,
                m.name AS material_name, m.base_unit
         FROM inventory_movements mv
         JOIN inventory_materials m ON m.id = mv.material_id
         WHERE mv.org_id = $1 AND mv.kind = 'dispatch' AND mv.voided_at IS NULL
           AND mv.from_location_id IS NOT DISTINCT FROM $2
           AND mv.to_location_id IS NOT DISTINCT FROM $3
           -- Compared in SQL: created_at carries microseconds that a JS Date
           -- would round away, and the batch shares that exact value.
           AND mv.created_at = (SELECT created_at FROM inventory_movements WHERE id = $4)
         ORDER BY mv.id`,
        [orgId, s.from_location_id, s.to_location_id, movementId]
    );
    return { seed: s, lines: r.rows };
}

async function shape(client, orgId, challan, batch) {
    const [org, locs] = await Promise.all([
        client.query(`SELECT name, address, phone, licence_no, gst FROM organizations WHERE id = $1`, [orgId]),
        client.query(
            `SELECT id, name, kind, bu_code, client_code FROM inventory_locations WHERE org_id = $1 AND id = ANY($2)`,
            [orgId, [batch.seed.from_location_id, batch.seed.to_location_id].filter(Boolean)]
        )
    ]);
    const loc = (id) => locs.rows.find((l) => l.id === id) || null;
    const first = batch.lines[0] || {};
    return {
        id: challan.id,
        number: challan.number,
        dispatched_at: challan.dispatched_at,
        occurred_at: first.occurred_at || challan.dispatched_at,
        reference: first.reference || null,
        note: first.note || null,
        details: challan.details || {},
        org: org.rows[0] || null,
        from: loc(batch.seed.from_location_id),
        to: loc(batch.seed.to_location_id),
        lines: batch.lines.map((l) => ({
            material_name: l.material_name,
            unit: l.base_unit,
            qty: Number(l.qty_base),
            pack_size: l.pack_size != null ? Number(l.pack_size) : null,
            pack_qty: l.pack_qty != null ? Number(l.pack_qty) : null
        }))
    };
}

/**
 * Challan for the dispatch batch that `movementId` belongs to: the existing
 * one (details merged in if given) or a new one with the next number.
 */
async function getOrCreateChallan(orgId, movementId, rawDetails, createdBy) {
    const details = cleanDetails(rawDetails);
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const batch = await loadBatch(client, orgId, movementId);
        const ids = batch.lines.map((l) => Number(l.id));
        let row = (
            await client.query(
                `SELECT * FROM inventory_challans WHERE org_id = $1 AND movement_ids && $2::bigint[] ORDER BY id LIMIT 1`,
                [orgId, ids]
            )
        ).rows[0];
        if (row) {
            if (Object.keys(details).length) {
                row = (
                    await client.query(
                        `UPDATE inventory_challans SET details = details || $2::jsonb WHERE id = $1 RETURNING *`,
                        [row.id, JSON.stringify(details)]
                    )
                ).rows[0];
            }
        } else {
            // One numbering sequence per org; the lock keeps two first prints
            // from taking the same number.
            await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`challan:${orgId}`]);
            const next = await client.query(
                `SELECT COALESCE(MAX(number), 0) + 1 AS n FROM inventory_challans WHERE org_id = $1`,
                [orgId]
            );
            row = (
                await client.query(
                    `INSERT INTO inventory_challans
                        (org_id, number, movement_ids, from_location_id, to_location_id, dispatched_at, details, created_by)
                     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
                     RETURNING *`,
                    [
                        orgId,
                        next.rows[0].n,
                        ids,
                        batch.seed.from_location_id,
                        batch.seed.to_location_id,
                        batch.seed.created_at,
                        JSON.stringify(details),
                        createdBy || null
                    ]
                )
            ).rows[0];
        }
        const out = await shape(client, orgId, row, batch);
        await client.query('COMMIT');
        return { challan: out };
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
    } finally {
        client.release();
    }
}

/** The challan already made for this movement's batch, if any (no number taken). */
async function findChallan(orgId, movementId) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        const batch = await loadBatch(client, orgId, movementId);
        const ids = batch.lines.map((l) => Number(l.id));
        const row = (
            await client.query(
                `SELECT * FROM inventory_challans WHERE org_id = $1 AND movement_ids && $2::bigint[] ORDER BY id LIMIT 1`,
                [orgId, ids]
            )
        ).rows[0];
        if (!row) {
            return { challan: null, lines: batch.lines.length };
        }
        return { challan: await shape(client, orgId, row, batch) };
    } finally {
        client.release();
    }
}

/** A challan by its running number, for re-rendering its PDF. */
async function getChallanByNumber(orgId, number) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        const row = (
            await client.query(`SELECT * FROM inventory_challans WHERE org_id = $1 AND number = $2`, [orgId, number])
        ).rows[0];
        if (!row) throw httpError('Challan not found', 404);
        const batch = await loadBatch(client, orgId, Number(row.movement_ids[0]));
        return shape(client, orgId, row, batch);
    } finally {
        client.release();
    }
}

module.exports = { getOrCreateChallan, findChallan, getChallanByNumber, DETAIL_KEYS };
