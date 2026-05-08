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

// -- Organizations CRUD ----------------------------------------------------
//
// Phase 10. super_admin only. The default 'org-default' row is seeded by
// migrate.js so the topbar switcher always has at least one entry; deleting
// or deactivating it is rejected here to keep that invariant.

router.get('/orgs', async (_req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const pool = getPool();
        const r = await pool.query(
            `SELECT o.id, o.slug, o.name, o.active, o.created_at,
                    (SELECT COUNT(*) FROM user_org_assignments a WHERE a.org_id = o.id) AS member_count
             FROM organizations o
             ORDER BY o.name`
        );
        res.json({ orgs: r.rows });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/orgs', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const slug = req.body && req.body.slug != null ? String(req.body.slug).trim().toLowerCase() : '';
        const name = req.body && req.body.name != null ? String(req.body.name).trim() : '';
        if (!slug || !name) {
            return res.status(400).json({ error: 'slug and name required' });
        }
        if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
            return res.status(400).json({
                error: 'slug must be lowercase alphanumeric with hyphens (no leading hyphen)'
            });
        }
        const pool = getPool();
        const id = `org-${crypto.randomBytes(6).toString('hex')}`;
        try {
            await pool.query(
                `INSERT INTO organizations (id, slug, name, active) VALUES ($1, $2, $3, true)`,
                [id, slug, name]
            );
        } catch (err) {
            if (err && err.code === '23505') {
                await logAudit(req, {
                    action: 'admin.org.create',
                    outcome: 'failure',
                    metadata: { reason: 'duplicate_slug', slug }
                });
                return res.status(409).json({ error: `Slug "${slug}" already exists` });
            }
            throw err;
        }
        const r = await pool.query(
            `SELECT id, slug, name, active, created_at FROM organizations WHERE id = $1`,
            [id]
        );
        await logAudit(req, {
            action: 'admin.org.create',
            outcome: 'success',
            targetType: 'org',
            targetId: id,
            before: null,
            after: { slug, name, active: true }
        });
        res.json({ org: r.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.patch('/orgs/:id', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const { id } = req.params;
        const pool = getPool();
        const before = await pool.query(
            `SELECT id, slug, name, active FROM organizations WHERE id = $1`,
            [id]
        );
        if (!before.rows.length) return res.status(404).json({ error: 'Not found' });
        const beforeRow = before.rows[0];
        const body = req.body || {};
        const changedFields = [];
        if (body.name != null) {
            const name = String(body.name).trim();
            if (!name) return res.status(400).json({ error: 'name cannot be empty' });
            await pool.query(`UPDATE organizations SET name = $1 WHERE id = $2`, [name, id]);
            changedFields.push('name');
        }
        if (typeof body.active === 'boolean') {
            if (id === 'org-default' && body.active === false) {
                return res.status(409).json({ error: 'org-default cannot be deactivated' });
            }
            await pool.query(`UPDATE organizations SET active = $1 WHERE id = $2`, [body.active, id]);
            changedFields.push('active');
        }
        const after = await pool.query(
            `SELECT id, slug, name, active, created_at FROM organizations WHERE id = $1`,
            [id]
        );
        await logAudit(req, {
            action: 'admin.org.update',
            outcome: 'success',
            targetType: 'org',
            targetId: id,
            before: { slug: beforeRow.slug, name: beforeRow.name, active: beforeRow.active },
            after: { slug: after.rows[0].slug, name: after.rows[0].name, active: after.rows[0].active },
            metadata: { changed_fields: changedFields }
        });
        res.json({ org: after.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.delete('/orgs/:id', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const { id } = req.params;
        if (id === 'org-default') {
            return res.status(409).json({ error: 'org-default cannot be deleted' });
        }
        const pool = getPool();
        const before = await pool.query(
            `SELECT id, slug, name, active FROM organizations WHERE id = $1`,
            [id]
        );
        if (!before.rows.length) return res.status(404).json({ error: 'Not found' });
        // Refuse to delete an org that still has members. Caller must reassign
        // them first — keeps the audit trail honest.
        const members = await pool.query(
            `SELECT COUNT(*)::int AS c FROM user_org_assignments WHERE org_id = $1`,
            [id]
        );
        if (members.rows[0].c > 0) {
            return res.status(409).json({
                error: `Cannot delete: ${members.rows[0].c} user(s) still assigned. Reassign first.`
            });
        }
        await pool.query(`DELETE FROM organizations WHERE id = $1`, [id]);
        await logAudit(req, {
            action: 'admin.org.delete',
            outcome: 'success',
            targetType: 'org',
            targetId: id,
            before: { slug: before.rows[0].slug, name: before.rows[0].name },
            after: null
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

// -- Per-user org assignments ---------------------------------------------

router.get('/users/:id/orgs', async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const pool = getPool();
        const r = await pool.query(
            `SELECT a.org_id, a.role AS membership_role, o.slug, o.name, o.active
             FROM user_org_assignments a
             JOIN organizations o ON o.id = a.org_id
             WHERE a.user_id = $1
             ORDER BY o.name`,
            [req.params.id]
        );
        res.json({ assignments: r.rows });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/users/:id/orgs', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const userId = req.params.id;
        const orgId = req.body && req.body.org_id != null ? String(req.body.org_id) : '';
        const role = req.body && req.body.role != null ? String(req.body.role) : 'member';
        if (!orgId) return res.status(400).json({ error: 'org_id required' });
        if (!['member', 'org_admin'].includes(role)) {
            return res.status(400).json({ error: "role must be 'member' or 'org_admin'" });
        }
        const pool = getPool();
        // Validate target user + org exist before INSERT so we get a clean 404
        // instead of an opaque FK violation.
        const u = await pool.query(`SELECT 1 FROM users WHERE id = $1`, [userId]);
        if (!u.rows.length) return res.status(404).json({ error: 'User not found' });
        const o = await pool.query(`SELECT 1 FROM organizations WHERE id = $1`, [orgId]);
        if (!o.rows.length) return res.status(404).json({ error: 'Org not found' });
        await pool.query(
            `INSERT INTO user_org_assignments (user_id, org_id, role)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, org_id) DO UPDATE SET role = EXCLUDED.role`,
            [userId, orgId, role]
        );
        await logAudit(req, {
            action: 'admin.user.org_assign',
            outcome: 'success',
            targetType: 'user',
            targetId: userId,
            after: { org_id: orgId, role }
        });
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.delete('/users/:id/orgs/:orgId', adminWriteLimiter, async (req, res) => {
    try {
        if (!useDatabase()) return res.status(503).json({ error: 'Database not configured' });
        const { id: userId, orgId } = req.params;
        const pool = getPool();
        const r = await pool.query(
            `DELETE FROM user_org_assignments WHERE user_id = $1 AND org_id = $2 RETURNING role`,
            [userId, orgId]
        );
        if (!r.rows.length) return res.status(404).json({ error: 'Assignment not found' });
        await logAudit(req, {
            action: 'admin.user.org_unassign',
            outcome: 'success',
            targetType: 'user',
            targetId: userId,
            before: { org_id: orgId, role: r.rows[0].role },
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
