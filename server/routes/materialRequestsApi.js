'use strict';

// Materials request API. Mounted at /api/material-requests from
// scripts/lis-nav-bot/server.js.
//
// Public (anonymous, code-gated):
//   POST /public/unlock  — validate org request code, return catalog
//   POST /public/submit  — create a request
//
// Authenticated (admin | super_admin), org-scoped via JWT active_org_id:
//   GET  /               — list requests
//   GET  /:id            — request detail
//   POST /:id/approve
//   POST /:id/cancel
//   GET  /batches
//   POST /batches        — consolidate approved requests
//   GET  /batches/:id
//   POST /batches/:id/submit
//   POST /batches/:id/cancel
//
// Authenticated (super_admin only):
//   POST /batches/:id/send

const express = require('express');
const { useDatabase } = require('../db/pool');
const { requireAuth, requireRole } = require('../auth');
const { adminWriteLimiter, materialRequestPublicLimiter } = require('../rateLimit');
const { logAudit } = require('../audit');
const mr = require('../db/materialRequests');

const router = express.Router();

const requireReviewer = requireRole('super_admin', 'admin');
const requireSuperAdmin = requireRole('super_admin');

const MAX_LINES = 50;
const MAX_NOTES = 2000;
const MAX_TEXT = 200;

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

function sendError(res, err) {
    const status = err && Number.isInteger(err.status) ? err.status : 500;
    res.status(status).json({ error: (err && err.message) || String(err) });
}

function trimStr(v) {
    return v != null ? String(v).trim() : '';
}

function parseNeededBy(v) {
    const s = trimStr(v);
    if (!s) return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const t = Date.parse(`${s}T00:00:00Z`);
    return Number.isFinite(t) ? s : false;
}

function sanitizePublicLines(raw) {
    if (!Array.isArray(raw)) {
        const err = new Error('lines must be an array');
        err.status = 400;
        throw err;
    }
    if (!raw.length) {
        const err = new Error('At least one line is required');
        err.status = 400;
        throw err;
    }
    if (raw.length > MAX_LINES) {
        const err = new Error(`At most ${MAX_LINES} lines allowed`);
        err.status = 400;
        throw err;
    }
    return raw.map((line, i) => {
        const qty = Number(line && line.quantity);
        if (!Number.isFinite(qty) || qty <= 0) {
            const err = new Error(`Line ${i + 1}: quantity must be a number > 0`);
            err.status = 400;
            throw err;
        }
        return {
            material_id: line && line.material_id != null ? trimStr(line.material_id) : '',
            material_name: line && line.material_name != null ? trimStr(line.material_name).slice(0, MAX_TEXT) : '',
            quantity: qty,
            unit: line && line.unit != null ? trimStr(line.unit).slice(0, 40) || 'unit' : 'unit'
        };
    });
}

// -- Public ----------------------------------------------------------------

router.post('/public/unlock', materialRequestPublicLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const code = mr.normalizeCode(req.body && req.body.code);
        const org = await mr.resolveOrgByRequestCode(code);
        const materials = await mr.listPublicCatalog(org.id);
        await logAudit(req, {
            action: 'material_request.public.unlock',
            outcome: 'success',
            targetType: 'org',
            targetId: org.id,
            metadata: { material_count: materials.length }
        });
        res.json({
            org: { id: org.id, name: org.name, slug: org.slug },
            materials
        });
    } catch (err) {
        if (err && err.status === 401) {
            await logAudit(req, {
                action: 'material_request.public.unlock',
                outcome: 'failure',
                metadata: { reason: 'invalid_code' }
            });
        }
        sendError(res, err);
    }
});

router.post('/public/submit', materialRequestPublicLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const body = req.body || {};
        const code = mr.normalizeCode(body.code);
        const org = await mr.resolveOrgByRequestCode(code);

        const requesterName = trimStr(body.requester_name).slice(0, MAX_TEXT);
        const requesterContact = trimStr(body.requester_contact).slice(0, MAX_TEXT);
        if (!requesterName) return res.status(400).json({ error: 'requester_name is required' });
        if (!requesterContact) return res.status(400).json({ error: 'requester_contact is required' });

        const neededBy = parseNeededBy(body.needed_by);
        if (neededBy === false) {
            return res.status(400).json({ error: 'needed_by must be YYYY-MM-DD' });
        }

        const lines = sanitizePublicLines(body.lines);
        const request = await mr.createRequest(org.id, {
            requesterName,
            requesterContact,
            locationText: trimStr(body.location_text).slice(0, MAX_TEXT) || null,
            neededBy,
            notes: trimStr(body.notes).slice(0, MAX_NOTES) || null,
            lines
        });

        await logAudit(req, {
            action: 'material_request.submit',
            outcome: 'success',
            targetType: 'material_request',
            targetId: request.id,
            after: {
                org_id: org.id,
                requester_name: requesterName,
                line_count: request.lines.length
            }
        });
        res.status(201).json({ request });
    } catch (err) {
        if (err && err.status === 401) {
            await logAudit(req, {
                action: 'material_request.submit',
                outcome: 'failure',
                metadata: { reason: 'invalid_code' }
            });
        }
        sendError(res, err);
    }
});

// -- Authenticated review --------------------------------------------------

router.use(requireAuth);

// Batches routes before /:id so "batches" is not captured as an id.
router.get('/batches', requireReviewer, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const status = req.query.status != null ? trimStr(req.query.status) : null;
        const batches = await mr.listBatches(orgOf(req), { status: status || null });
        res.json({ batches });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/batches', requireReviewer, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const body = req.body || {};
        const requestIds = Array.isArray(body.request_ids) ? body.request_ids : [];
        const note = body.note != null ? trimStr(body.note).slice(0, MAX_NOTES) : null;
        const batch = await mr.createBatch(orgOf(req), requestIds, req.user, note);
        await logAudit(req, {
            action: 'material_request.combine',
            outcome: 'success',
            targetType: 'material_request_batch',
            targetId: batch.id,
            after: {
                request_ids: requestIds,
                request_count: batch.request_count,
                status: batch.status
            }
        });
        res.status(201).json({ batch });
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/batches/:id', requireReviewer, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const batch = await mr.getBatch(orgOf(req), req.params.id);
        if (!batch) return res.status(404).json({ error: 'Batch not found' });
        res.json({ batch });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/batches/:id/submit', requireReviewer, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const before = await mr.getBatch(orgOf(req), req.params.id);
        if (!before) return res.status(404).json({ error: 'Batch not found' });
        const batch = await mr.submitBatch(orgOf(req), req.params.id, req.user);
        await logAudit(req, {
            action: 'material_request.batch.submit',
            outcome: 'success',
            targetType: 'material_request_batch',
            targetId: batch.id,
            before: { status: before.status },
            after: { status: batch.status }
        });
        res.json({ batch });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/batches/:id/send', requireSuperAdmin, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const before = await mr.getBatch(orgOf(req), req.params.id);
        if (!before) return res.status(404).json({ error: 'Batch not found' });
        const batch = await mr.markBatchSent(orgOf(req), req.params.id, req.user);
        await logAudit(req, {
            action: 'material_request.batch.send',
            outcome: 'success',
            targetType: 'material_request_batch',
            targetId: batch.id,
            before: { status: before.status },
            after: { status: batch.status }
        });
        res.json({ batch });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/batches/:id/cancel', requireReviewer, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const reason = req.body && req.body.reason != null ? trimStr(req.body.reason).slice(0, MAX_TEXT) : null;
        const before = await mr.getBatch(orgOf(req), req.params.id);
        if (!before) return res.status(404).json({ error: 'Batch not found' });
        // Admins may cancel draft/submitted; super_admin also covered by requireReviewer.
        if (before.status === 'sent' && req.user.role !== 'super_admin') {
            return res.status(403).json({ error: 'Only super_admin can act on sent batches' });
        }
        const batch = await mr.cancelBatch(orgOf(req), req.params.id, req.user, reason);
        await logAudit(req, {
            action: 'material_request.batch.cancel',
            outcome: 'success',
            targetType: 'material_request_batch',
            targetId: batch.id,
            before: { status: before.status },
            after: { status: batch.status, cancel_reason: reason }
        });
        res.json({ batch });
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/', requireReviewer, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const status = req.query.status != null ? trimStr(req.query.status) : null;
        const requests = await mr.listRequests(orgOf(req), { status: status || null });
        res.json({ requests });
    } catch (err) {
        sendError(res, err);
    }
});

router.get('/:id', requireReviewer, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const request = await mr.getRequest(orgOf(req), req.params.id);
        if (!request) return res.status(404).json({ error: 'Request not found' });
        res.json({ request });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/:id/approve', requireReviewer, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const before = await mr.getRequest(orgOf(req), req.params.id);
        if (!before) return res.status(404).json({ error: 'Request not found' });
        const request = await mr.approveRequest(orgOf(req), req.params.id, req.user);
        await logAudit(req, {
            action: 'material_request.approve',
            outcome: 'success',
            targetType: 'material_request',
            targetId: request.id,
            before: { status: before.status },
            after: { status: request.status }
        });
        res.json({ request });
    } catch (err) {
        sendError(res, err);
    }
});

router.post('/:id/cancel', requireReviewer, adminWriteLimiter, async (req, res) => {
    if (!dbGuard(res)) return;
    try {
        const reason = req.body && req.body.reason != null ? trimStr(req.body.reason).slice(0, MAX_TEXT) : null;
        const before = await mr.getRequest(orgOf(req), req.params.id);
        if (!before) return res.status(404).json({ error: 'Request not found' });
        const request = await mr.cancelRequest(orgOf(req), req.params.id, req.user, reason);
        await logAudit(req, {
            action: 'material_request.cancel',
            outcome: 'success',
            targetType: 'material_request',
            targetId: request.id,
            before: { status: before.status },
            after: { status: request.status, cancel_reason: reason }
        });
        res.json({ request });
    } catch (err) {
        sendError(res, err);
    }
});

module.exports = router;
