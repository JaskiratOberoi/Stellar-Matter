'use strict';

// Materials request data layer. Public submissions are org-scoped via a shared
// request code (hash stored on organizations). Authenticated admins approve /
// cancel / consolidate approved requests into batches; super_admins mark batches
// sent. Every mutating helper runs in a transaction and locks rows so a request
// cannot land in two batches.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool } = require('./pool');

const REQUEST_STATUSES = new Set(['submitted', 'approved', 'batched', 'cancelled']);
const BATCH_STATUSES = new Set(['draft', 'submitted', 'sent', 'cancelled']);

function httpError(message, status, extra) {
    const err = new Error(message);
    err.status = status;
    if (extra) Object.assign(err, extra);
    return err;
}

function newRequestId() {
    return `mreq-${crypto.randomBytes(8).toString('hex')}`;
}

function newBatchId() {
    return `mrbat-${crypto.randomBytes(8).toString('hex')}`;
}

function generateRequestCode() {
    // 10-char uppercase alphanumeric, omitting ambiguous 0/O/1/I.
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(10);
    let out = '';
    for (let i = 0; i < 10; i++) out += alphabet[bytes[i] % alphabet.length];
    return out;
}

function normalizeCode(code) {
    return String(code || '')
        .trim()
        .toUpperCase()
        .replace(/\s+/g, '');
}

function actorLabel(actor) {
    if (!actor) return null;
    return actor.displayName || actor.username || actor.id || null;
}

function mapRequestRow(row, lines = []) {
    if (!row) return null;
    return {
        id: row.id,
        org_id: row.org_id,
        status: row.status,
        requester_name: row.requester_name,
        requester_contact: row.requester_contact,
        location_text: row.location_text,
        needed_by: row.needed_by,
        notes: row.notes,
        created_at: row.created_at,
        approved_at: row.approved_at,
        approved_by: row.approved_by,
        cancelled_at: row.cancelled_at,
        cancelled_by: row.cancelled_by,
        cancel_reason: row.cancel_reason,
        batch_id: row.batch_id,
        line_count: row.line_count != null ? Number(row.line_count) : lines.length,
        lines
    };
}

function mapLineRow(row) {
    return {
        id: row.id,
        request_id: row.request_id,
        material_id: row.material_id,
        material_name: row.material_name,
        is_custom: !!row.is_custom,
        quantity: Number(row.quantity),
        unit: row.unit,
        position: row.position
    };
}

function mapBatchRow(row, requests = []) {
    if (!row) return null;
    return {
        id: row.id,
        org_id: row.org_id,
        status: row.status,
        note: row.note,
        created_at: row.created_at,
        created_by: row.created_by,
        submitted_at: row.submitted_at,
        submitted_by: row.submitted_by,
        sent_at: row.sent_at,
        sent_by: row.sent_by,
        cancelled_at: row.cancelled_at,
        cancelled_by: row.cancelled_by,
        cancel_reason: row.cancel_reason,
        request_count: row.request_count != null ? Number(row.request_count) : requests.length,
        requests
    };
}

// -- Request codes ---------------------------------------------------------

async function getOrgRequestCodeMeta(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, slug, name, active,
                (request_code_hash IS NOT NULL) AS has_request_code,
                request_code_set_at
         FROM organizations
         WHERE id = $1`,
        [orgId]
    );
    return r.rows[0] || null;
}

async function resetOrgRequestCode(orgId) {
    const pool = getPool();
    const before = await pool.query(
        `SELECT id, slug, name, active, request_code_hash IS NOT NULL AS had_code
         FROM organizations WHERE id = $1`,
        [orgId]
    );
    if (!before.rows.length) throw httpError('Organization not found', 404);
    if (!before.rows[0].active) throw httpError('Organization is inactive', 409);

    const code = generateRequestCode();
    const hash = bcrypt.hashSync(code, 10);
    await pool.query(
        `UPDATE organizations
         SET request_code_hash = $2, request_code_set_at = NOW()
         WHERE id = $1`,
        [orgId, hash]
    );
    return {
        org: {
            id: before.rows[0].id,
            slug: before.rows[0].slug,
            name: before.rows[0].name,
            has_request_code: true,
            request_code_set_at: new Date().toISOString()
        },
        code,
        replaced: !!before.rows[0].had_code
    };
}

async function resolveOrgByRequestCode(code) {
    const normalized = normalizeCode(code);
    if (!normalized || normalized.length < 6) {
        throw httpError('Invalid request code', 401);
    }
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, slug, name, active, request_code_hash
         FROM organizations
         WHERE active = true AND request_code_hash IS NOT NULL`
    );
    for (const row of r.rows) {
        if (bcrypt.compareSync(normalized, row.request_code_hash)) {
            return { id: row.id, slug: row.slug, name: row.name };
        }
    }
    throw httpError('Invalid request code', 401);
}

async function listPublicCatalog(orgId) {
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, name, sku, base_unit, default_pack_size, default_pack_label
         FROM inventory_materials
         WHERE org_id = $1 AND active = true
         ORDER BY name`,
        [orgId]
    );
    return r.rows;
}

// -- Requests --------------------------------------------------------------

async function loadLines(client, requestId) {
    const r = await client.query(
        `SELECT id, request_id, material_id, material_name, is_custom,
                quantity, unit, position
         FROM material_request_lines
         WHERE request_id = $1
         ORDER BY position, id`,
        [requestId]
    );
    return r.rows.map(mapLineRow);
}

async function getRequest(orgId, id, { client = null } = {}) {
    const db = client || getPool();
    const r = await db.query(
        `SELECT id, org_id, status, requester_name, requester_contact,
                location_text, needed_by, notes, created_at,
                approved_at, approved_by, cancelled_at, cancelled_by,
                cancel_reason, batch_id
         FROM material_requests
         WHERE org_id = $1 AND id = $2`,
        [orgId, id]
    );
    if (!r.rows.length) return null;
    const lines = await loadLines(db, id);
    return mapRequestRow(r.rows[0], lines);
}

async function createRequest(orgId, fields) {
    const pool = getPool();
    const client = await pool.connect();
    const id = newRequestId();
    try {
        await client.query('BEGIN');

        const lines = Array.isArray(fields.lines) ? fields.lines : [];
        if (!lines.length) throw httpError('At least one line is required', 400);

        const resolved = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i] || {};
            const qty = Number(line.quantity);
            if (!Number.isFinite(qty) || qty <= 0) {
                throw httpError(`Line ${i + 1}: quantity must be a number > 0`, 400);
            }
            const unit = String(line.unit || 'unit').trim() || 'unit';
            const materialId = line.material_id ? String(line.material_id).trim() : '';
            const customName = line.material_name != null ? String(line.material_name).trim() : '';

            if (materialId) {
                const mat = await client.query(
                    `SELECT id, name, base_unit FROM inventory_materials
                     WHERE org_id = $1 AND id = $2 AND active = true`,
                    [orgId, materialId]
                );
                if (!mat.rows.length) {
                    throw httpError(`Line ${i + 1}: unknown or inactive material`, 400);
                }
                resolved.push({
                    materialId: mat.rows[0].id,
                    materialName: mat.rows[0].name,
                    isCustom: false,
                    quantity: qty,
                    unit: unit || mat.rows[0].base_unit || 'unit',
                    position: i
                });
            } else if (customName) {
                resolved.push({
                    materialId: null,
                    materialName: customName.slice(0, 200),
                    isCustom: true,
                    quantity: qty,
                    unit,
                    position: i
                });
            } else {
                throw httpError(`Line ${i + 1}: material or custom name required`, 400);
            }
        }

        await client.query(
            `INSERT INTO material_requests
                (id, org_id, status, requester_name, requester_contact,
                 location_text, needed_by, notes)
             VALUES ($1, $2, 'submitted', $3, $4, $5, $6, $7)`,
            [
                id,
                orgId,
                fields.requesterName,
                fields.requesterContact,
                fields.locationText || null,
                fields.neededBy || null,
                fields.notes || null
            ]
        );

        for (const line of resolved) {
            await client.query(
                `INSERT INTO material_request_lines
                    (request_id, material_id, material_name, is_custom, quantity, unit, position)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [
                    id,
                    line.materialId,
                    line.materialName,
                    line.isCustom,
                    line.quantity,
                    line.unit,
                    line.position
                ]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getRequest(orgId, id);
}

async function listRequests(orgId, { status = null } = {}) {
    const pool = getPool();
    const params = [orgId];
    let statusClause = '';
    if (status) {
        if (!REQUEST_STATUSES.has(status)) throw httpError('Invalid status filter', 400);
        params.push(status);
        statusClause = `AND r.status = $${params.length}`;
    }
    const r = await pool.query(
        `SELECT r.id, r.org_id, r.status, r.requester_name, r.requester_contact,
                r.location_text, r.needed_by, r.notes, r.created_at,
                r.approved_at, r.approved_by, r.cancelled_at, r.cancelled_by,
                r.cancel_reason, r.batch_id,
                (SELECT COUNT(*)::int FROM material_request_lines l WHERE l.request_id = r.id) AS line_count
         FROM material_requests r
         WHERE r.org_id = $1 ${statusClause}
         ORDER BY r.created_at DESC`,
        params
    );
    return r.rows.map((row) => mapRequestRow(row));
}

async function approveRequest(orgId, id, actor) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id, status FROM material_requests
             WHERE org_id = $1 AND id = $2
             FOR UPDATE`,
            [orgId, id]
        );
        if (!locked.rows.length) throw httpError('Request not found', 404);
        if (locked.rows[0].status !== 'submitted') {
            throw httpError(`Only submitted requests can be approved (current: ${locked.rows[0].status})`, 409);
        }
        await client.query(
            `UPDATE material_requests
             SET status = 'approved', approved_at = NOW(), approved_by = $3
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, actorLabel(actor)]
        );
        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getRequest(orgId, id);
}

async function cancelRequest(orgId, id, actor, reason) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id, status FROM material_requests
             WHERE org_id = $1 AND id = $2
             FOR UPDATE`,
            [orgId, id]
        );
        if (!locked.rows.length) throw httpError('Request not found', 404);
        const status = locked.rows[0].status;
        if (status === 'batched') {
            throw httpError('Batched requests cannot be cancelled; cancel the batch instead', 409);
        }
        if (status === 'cancelled') {
            throw httpError('Request is already cancelled', 409);
        }
        await client.query(
            `UPDATE material_requests
             SET status = 'cancelled',
                 cancelled_at = NOW(),
                 cancelled_by = $3,
                 cancel_reason = $4
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, actorLabel(actor), reason || null]
        );
        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getRequest(orgId, id);
}

// -- Batches ---------------------------------------------------------------

async function loadBatchRequests(client, batchId, orgId) {
    const r = await client.query(
        `SELECT r.id, r.org_id, r.status, r.requester_name, r.requester_contact,
                r.location_text, r.needed_by, r.notes, r.created_at,
                r.approved_at, r.approved_by, r.cancelled_at, r.cancelled_by,
                r.cancel_reason, r.batch_id,
                (SELECT COUNT(*)::int FROM material_request_lines l WHERE l.request_id = r.id) AS line_count
         FROM material_request_batch_items bi
         JOIN material_requests r ON r.id = bi.request_id
         WHERE bi.batch_id = $1 AND r.org_id = $2
         ORDER BY r.created_at`,
        [batchId, orgId]
    );
    const out = [];
    for (const row of r.rows) {
        const lines = await loadLines(client, row.id);
        out.push(mapRequestRow(row, lines));
    }
    return out;
}

async function getBatch(orgId, id, { client = null } = {}) {
    const db = client || getPool();
    const r = await db.query(
        `SELECT b.id, b.org_id, b.status, b.note, b.created_at, b.created_by,
                b.submitted_at, b.submitted_by, b.sent_at, b.sent_by,
                b.cancelled_at, b.cancelled_by, b.cancel_reason,
                (SELECT COUNT(*)::int FROM material_request_batch_items bi WHERE bi.batch_id = b.id) AS request_count
         FROM material_request_batches b
         WHERE b.org_id = $1 AND b.id = $2`,
        [orgId, id]
    );
    if (!r.rows.length) return null;
    const requests = await loadBatchRequests(db, id, orgId);
    return mapBatchRow(r.rows[0], requests);
}

async function listBatches(orgId, { status = null } = {}) {
    const pool = getPool();
    const params = [orgId];
    let statusClause = '';
    if (status) {
        if (!BATCH_STATUSES.has(status)) throw httpError('Invalid status filter', 400);
        params.push(status);
        statusClause = `AND b.status = $${params.length}`;
    }
    const r = await pool.query(
        `SELECT b.id, b.org_id, b.status, b.note, b.created_at, b.created_by,
                b.submitted_at, b.submitted_by, b.sent_at, b.sent_by,
                b.cancelled_at, b.cancelled_by, b.cancel_reason,
                (SELECT COUNT(*)::int FROM material_request_batch_items bi WHERE bi.batch_id = b.id) AS request_count
         FROM material_request_batches b
         WHERE b.org_id = $1 ${statusClause}
         ORDER BY b.created_at DESC`,
        params
    );
    return r.rows.map((row) => mapBatchRow(row));
}

async function createBatch(orgId, requestIds, actor, note) {
    const ids = Array.from(new Set((requestIds || []).map((x) => String(x).trim()).filter(Boolean)));
    if (ids.length < 1) throw httpError('Select at least one approved request', 400);

    const pool = getPool();
    const client = await pool.connect();
    const batchId = newBatchId();
    try {
        await client.query('BEGIN');

        // Lock in a stable order to avoid deadlocks across concurrent combines.
        const locked = await client.query(
            `SELECT id, status, batch_id FROM material_requests
             WHERE org_id = $1 AND id = ANY($2::text[])
             ORDER BY id
             FOR UPDATE`,
            [orgId, ids]
        );
        if (locked.rows.length !== ids.length) {
            throw httpError('One or more requests were not found in this organization', 404);
        }
        for (const row of locked.rows) {
            if (row.status !== 'approved') {
                throw httpError(`Request ${row.id} is ${row.status}, not approved`, 409);
            }
            if (row.batch_id) {
                throw httpError(`Request ${row.id} is already in a batch`, 409);
            }
        }

        await client.query(
            `INSERT INTO material_request_batches
                (id, org_id, status, note, created_by)
             VALUES ($1, $2, 'draft', $3, $4)`,
            [batchId, orgId, note || null, actorLabel(actor)]
        );

        for (const row of locked.rows) {
            await client.query(
                `INSERT INTO material_request_batch_items (batch_id, request_id)
                 VALUES ($1, $2)`,
                [batchId, row.id]
            );
            await client.query(
                `UPDATE material_requests
                 SET status = 'batched', batch_id = $2
                 WHERE id = $1`,
                [row.id, batchId]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        if (err && err.code === '23505') {
            throw httpError('One or more requests were already batched', 409);
        }
        throw err;
    } finally {
        client.release();
    }
    return getBatch(orgId, batchId);
}

async function submitBatch(orgId, id, actor) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id, status FROM material_request_batches
             WHERE org_id = $1 AND id = $2
             FOR UPDATE`,
            [orgId, id]
        );
        if (!locked.rows.length) throw httpError('Batch not found', 404);
        if (locked.rows[0].status !== 'draft') {
            throw httpError(`Only draft batches can be submitted (current: ${locked.rows[0].status})`, 409);
        }
        await client.query(
            `UPDATE material_request_batches
             SET status = 'submitted', submitted_at = NOW(), submitted_by = $3
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, actorLabel(actor)]
        );
        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getBatch(orgId, id);
}

async function markBatchSent(orgId, id, actor) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id, status FROM material_request_batches
             WHERE org_id = $1 AND id = $2
             FOR UPDATE`,
            [orgId, id]
        );
        if (!locked.rows.length) throw httpError('Batch not found', 404);
        if (locked.rows[0].status !== 'submitted') {
            throw httpError(`Only submitted batches can be marked sent (current: ${locked.rows[0].status})`, 409);
        }
        await client.query(
            `UPDATE material_request_batches
             SET status = 'sent', sent_at = NOW(), sent_by = $3
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, actorLabel(actor)]
        );
        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getBatch(orgId, id);
}

async function cancelBatch(orgId, id, actor, reason) {
    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const locked = await client.query(
            `SELECT id, status FROM material_request_batches
             WHERE org_id = $1 AND id = $2
             FOR UPDATE`,
            [orgId, id]
        );
        if (!locked.rows.length) throw httpError('Batch not found', 404);
        const status = locked.rows[0].status;
        if (status === 'sent') {
            throw httpError('Sent batches cannot be cancelled', 409);
        }
        if (status === 'cancelled') {
            throw httpError('Batch is already cancelled', 409);
        }

        // Release member requests back to approved so they can be recombined.
        await client.query(
            `UPDATE material_requests
             SET status = 'approved', batch_id = NULL
             WHERE org_id = $1 AND batch_id = $2 AND status = 'batched'`,
            [orgId, id]
        );
        await client.query(`DELETE FROM material_request_batch_items WHERE batch_id = $1`, [id]);
        await client.query(
            `UPDATE material_request_batches
             SET status = 'cancelled',
                 cancelled_at = NOW(),
                 cancelled_by = $3,
                 cancel_reason = $4
             WHERE org_id = $1 AND id = $2`,
            [orgId, id, actorLabel(actor), reason || null]
        );
        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch {
            /* ignore */
        }
        throw err;
    } finally {
        client.release();
    }
    return getBatch(orgId, id);
}

module.exports = {
    REQUEST_STATUSES,
    BATCH_STATUSES,
    normalizeCode,
    generateRequestCode,
    getOrgRequestCodeMeta,
    resetOrgRequestCode,
    resolveOrgByRequestCode,
    listPublicCatalog,
    createRequest,
    listRequests,
    getRequest,
    approveRequest,
    cancelRequest,
    listBatches,
    getBatch,
    createBatch,
    submitBatch,
    markBatchSent,
    cancelBatch
};
