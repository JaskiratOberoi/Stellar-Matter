'use strict';

// Stellar Matter admin endpoints — narrower than Shark's. Currently only
// /users (super_admin can create operators / viewers, reset passwords,
// toggle active). Org management lands in Phase 10.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const express = require('express');
const { getPool, useDatabase } = require('../db/pool');
const { requireAuth, requireRole } = require('../auth');
const { adminWriteLimiter } = require('../rateLimit');
const { logAudit } = require('../audit');

const router = express.Router();

router.use(requireAuth);
router.use(requireRole('super_admin'));

const ALLOWED_NEW_ROLES = new Set(['operator', 'viewer']);

function newUserId() {
    return `user-${crypto.randomBytes(8).toString('hex')}`;
}

router.get('/users', async (_req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const pool = getPool();
        const r = await pool.query(
            `SELECT id, username, display_name, role, active, created_at
             FROM users
             ORDER BY created_at DESC`
        );
        res.json({ users: r.rows });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/users', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const username = req.body && req.body.username != null ? String(req.body.username).trim() : '';
        const password = req.body && req.body.password != null ? String(req.body.password) : '';
        const displayName = req.body && req.body.display_name != null ? String(req.body.display_name).trim() : '';
        const requestedRole = req.body && req.body.role != null ? String(req.body.role) : 'operator';
        if (!username || !password || !displayName) {
            return res.status(400).json({ error: 'username, password, display_name required' });
        }
        if (password.length < 8) {
            return res.status(400).json({ error: 'Password must be at least 8 characters.' });
        }
        if (!ALLOWED_NEW_ROLES.has(requestedRole)) {
            return res.status(400).json({ error: `role must be one of: ${[...ALLOWED_NEW_ROLES].join(', ')}` });
        }
        const pool = getPool();
        const id = newUserId();
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            `INSERT INTO users (id, username, password_hash, display_name, role, active)
             VALUES ($1, $2, $3, $4, $5, true)`,
            [id, username, hash, displayName, requestedRole]
        );
        const r = await pool.query(
            `SELECT id, username, display_name, role, active, created_at FROM users WHERE id = $1`,
            [id]
        );
        const created = r.rows[0];
        await logAudit(req, {
            action: 'admin.user.create',
            targetType: 'user',
            targetId: created.id,
            outcome: 'success',
            before: null,
            after: {
                username: created.username,
                display_name: created.display_name,
                role: created.role,
                active: created.active
            }
        });
        res.json({ user: created });
    } catch (err) {
        if (String(err.message || '').includes('unique') || (err && err.code === '23505')) {
            await logAudit(req, {
                action: 'admin.user.create',
                outcome: 'failure',
                targetType: 'user',
                metadata: { reason: 'duplicate_username', username }
            });
            return res.status(409).json({ error: 'Username already exists' });
        }
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.patch('/users/:id', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const { id } = req.params;
        const pool = getPool();
        const body = req.body || {};

        // Snapshot the row before mutation so the audit log can diff before/after.
        const beforeRow = await pool.query(
            `SELECT id, username, display_name, role, active FROM users WHERE id = $1`,
            [id]
        );
        const beforeSnapshot = beforeRow.rows[0]
            ? {
                  username: beforeRow.rows[0].username,
                  display_name: beforeRow.rows[0].display_name,
                  role: beforeRow.rows[0].role,
                  active: beforeRow.rows[0].active
              }
            : null;

        // Footgun: super_admin cannot deactivate themselves.
        if (body.active === false && req.user && req.user.id === id) {
            return res.status(409).json({ error: 'You cannot deactivate your own account.' });
        }

        if (body.password != null) {
            const pw = String(body.password);
            if (pw.length < 8) {
                return res.status(400).json({ error: 'Password must be at least 8 characters.' });
            }
            const hash = await bcrypt.hash(pw, 10);
            await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, id]);
        }
        if (body.display_name != null) {
            const dn = String(body.display_name).trim();
            if (!dn) return res.status(400).json({ error: 'Display name cannot be empty.' });
            await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [dn, id]);
        }
        if (typeof body.active === 'boolean') {
            await pool.query(`UPDATE users SET active = $1 WHERE id = $2`, [body.active, id]);
        }
        if (body.role != null) {
            const newRole = String(body.role);
            if (!ALLOWED_NEW_ROLES.has(newRole)) {
                return res.status(400).json({
                    error: `role must be one of: ${[...ALLOWED_NEW_ROLES].join(', ')}`
                });
            }
            // Prevent demoting yourself out of super_admin if you somehow PATCH your own role.
            if (req.user && req.user.id === id && req.user.role === 'super_admin') {
                return res.status(409).json({ error: 'Cannot demote your own super_admin role.' });
            }
            await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [newRole, id]);
        }
        const r = await pool.query(
            `SELECT id, username, display_name, role, active, created_at FROM users WHERE id = $1`,
            [id]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
        const updated = r.rows[0];
        const afterSnapshot = {
            username: updated.username,
            display_name: updated.display_name,
            role: updated.role,
            active: updated.active
        };
        // Track which fields actually changed so the audit row makes diffing
        // easy without comparing the whole jsonb in queries.
        const changedFields = beforeSnapshot
            ? Object.keys(afterSnapshot).filter((k) => afterSnapshot[k] !== beforeSnapshot[k])
            : Object.keys(afterSnapshot);
        if (body.password != null) changedFields.push('password');
        await logAudit(req, {
            action: 'admin.user.update',
            targetType: 'user',
            targetId: id,
            outcome: 'success',
            before: beforeSnapshot,
            after: afterSnapshot,
            metadata: { changed_fields: Array.from(new Set(changedFields)) }
        });
        res.json({ user: updated });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.delete('/users/:id', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const { id } = req.params;
        if (req.user && req.user.id === id) {
            return res.status(409).json({ error: 'You cannot delete your own account.' });
        }
        const pool = getPool();
        const target = await pool.query(
            `SELECT id, username, display_name, role, active FROM users WHERE id = $1`,
            [id]
        );
        if (!target.rows.length) return res.status(404).json({ error: 'Not found' });
        if (target.rows[0].role === 'super_admin') {
            return res.status(409).json({ error: 'Cannot delete a super_admin via this endpoint.' });
        }
        const beforeSnapshot = {
            username: target.rows[0].username,
            display_name: target.rows[0].display_name,
            role: target.rows[0].role,
            active: target.rows[0].active
        };
        await pool.query(`DELETE FROM users WHERE id = $1`, [id]);
        await logAudit(req, {
            action: 'admin.user.delete',
            targetType: 'user',
            targetId: id,
            outcome: 'success',
            before: beforeSnapshot,
            after: null
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// Audit log read endpoint. Paginated with simple filters: action prefix
// (e.g. 'auth.', 'admin.user.', 'run.'), actor id, target id, outcome.
// Limit caps at 200 to keep one response within reason; the SPA paginates
// older history by passing `before_id` (cursor) for an indexed seek.
router.get('/audit-log', async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const pool = getPool();
        const limitRaw = Number(req.query.limit);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(1, Math.floor(limitRaw)), 200) : 50;
        const where = [];
        const params = [];
        if (req.query.action) {
            params.push(`${String(req.query.action)}%`);
            where.push(`action ILIKE $${params.length}`);
        }
        if (req.query.actor_id) {
            params.push(String(req.query.actor_id));
            where.push(`actor_id = $${params.length}`);
        }
        if (req.query.target_id) {
            params.push(String(req.query.target_id));
            where.push(`target_id = $${params.length}`);
        }
        if (req.query.outcome === 'success' || req.query.outcome === 'failure') {
            params.push(req.query.outcome);
            where.push(`outcome = $${params.length}`);
        }
        if (req.query.before_id) {
            const beforeId = Number(req.query.before_id);
            if (Number.isFinite(beforeId)) {
                params.push(beforeId);
                where.push(`id < $${params.length}`);
            }
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        params.push(limit);
        const r = await pool.query(
            `SELECT id, created_at, actor_id, actor_username, action, target_type,
                    target_id, outcome, ip, user_agent, "before", "after", metadata
             FROM audit_log
             ${whereSql}
             ORDER BY id DESC
             LIMIT $${params.length}`,
            params
        );
        const next_cursor = r.rows.length === limit ? r.rows[r.rows.length - 1].id : null;
        res.json({ entries: r.rows, next_cursor });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

module.exports = router;
