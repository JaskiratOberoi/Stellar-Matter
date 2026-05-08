'use strict';

// Lifted from Stellar-Shark/server/routes/authApi.js. Trimmed to the
// Stellar Matter user shape. Phase 10 adds active_org_id to login + /me
// responses and a POST /switch-org endpoint that re-mints the JWT with a
// new active org.

const express = require('express');
const bcrypt = require('bcryptjs');
const { getPool, useDatabase } = require('../db/pool');
const { signToken, requireAuth, loadUserById, loadOrgsForUser, pickInitialActiveOrg } = require('../auth');
const { loginLimiter } = require('../rateLimit');
const { logAudit } = require('../audit');

const router = express.Router();

router.post('/login', loginLimiter, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured. Set DATABASE_URL.' });
        }
        const username = req.body && req.body.username != null ? String(req.body.username).trim() : '';
        const password = req.body && req.body.password != null ? String(req.body.password) : '';
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password required' });
        }
        const pool = getPool();
        const r = await pool.query(
            `SELECT id, username, password_hash, display_name, role, active FROM users WHERE username = $1`,
            [username]
        );
        if (r.rows.length === 0) {
            await logAudit(req, {
                action: 'auth.login',
                outcome: 'failure',
                actorUsername: username,
                metadata: { reason: 'unknown_user' }
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const u = r.rows[0];
        if (!u.active) {
            await logAudit(req, {
                action: 'auth.login',
                outcome: 'failure',
                actorId: u.id,
                actorUsername: u.username,
                metadata: { reason: 'account_disabled' }
            });
            return res.status(403).json({ error: 'Account disabled' });
        }
        const ok = await bcrypt.compare(password, u.password_hash);
        if (!ok) {
            await logAudit(req, {
                action: 'auth.login',
                outcome: 'failure',
                actorId: u.id,
                actorUsername: u.username,
                metadata: { reason: 'bad_password' }
            });
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const activeOrgId = await pickInitialActiveOrg(pool, { id: u.id, role: u.role });
        const token = signToken({
            sub: u.id,
            username: u.username,
            role: u.role,
            displayName: u.display_name,
            active_org_id: activeOrgId
        });
        await logAudit(req, {
            action: 'auth.login',
            outcome: 'success',
            actorId: u.id,
            actorUsername: u.username,
            metadata: { role: u.role, active_org_id: activeOrgId }
        });
        const orgs = await loadOrgsForUser(pool, { id: u.id, role: u.role });
        res.json({
            token,
            user: {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role,
                active_org_id: activeOrgId
            },
            orgs
        });
    } catch (err) {
        console.error('[auth] login', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.get('/me', requireAuth, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.json({ user: null, guest: true });
        }
        if (!req.user) {
            return res.json({ user: null, guest: true });
        }
        const pool = getPool();
        const u = await loadUserById(pool, req.user.id);
        if (!u || !u.active) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const orgs = await loadOrgsForUser(pool, { id: u.id, role: u.role });
        // active_org_id from JWT must still be a valid assignment for non-super_admin.
        // If it isn't (org deleted, assignment revoked), drop to the first available
        // org and signal the SPA via stale_active_org so it can refresh its token.
        let activeOrgId = req.user.activeOrgId;
        let staleOrg = false;
        if (u.role !== 'super_admin') {
            const allowed = new Set(orgs.map((o) => o.id));
            if (!activeOrgId || !allowed.has(activeOrgId)) {
                activeOrgId = orgs.length ? orgs[0].id : null;
                staleOrg = true;
            }
        } else if (!activeOrgId) {
            // super_admin with no active_org_id (legacy token): pick first.
            activeOrgId = orgs.length ? orgs[0].id : 'org-default';
            staleOrg = true;
        }
        res.json({
            user: {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role,
                active_org_id: activeOrgId
            },
            orgs,
            stale_active_org: staleOrg,
            guest: false
        });
    } catch (err) {
        console.error('[auth] me', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/switch-org', requireAuth, async (req, res) => {
    try {
        if (!useDatabase()) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        if (!req.user) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const orgId = req.body && req.body.org_id != null ? String(req.body.org_id) : '';
        if (!orgId) {
            return res.status(400).json({ error: 'org_id required' });
        }
        const pool = getPool();
        // Authorisation: super_admin can switch into any active org; everyone
        // else must have an assignment for the target org.
        let allowed = false;
        if (req.user.role === 'super_admin') {
            const r = await pool.query(`SELECT 1 FROM organizations WHERE id = $1 AND active = true`, [orgId]);
            allowed = r.rows.length > 0;
        } else {
            const r = await pool.query(
                `SELECT 1 FROM user_org_assignments a
                 JOIN organizations o ON o.id = a.org_id
                 WHERE a.user_id = $1 AND a.org_id = $2 AND o.active = true`,
                [req.user.id, orgId]
            );
            allowed = r.rows.length > 0;
        }
        if (!allowed) {
            await logAudit(req, {
                action: 'auth.switch_org',
                outcome: 'failure',
                targetType: 'org',
                targetId: orgId,
                metadata: { reason: 'not_assigned' }
            });
            return res.status(403).json({ error: 'Forbidden — not assigned to org' });
        }
        const u = await loadUserById(pool, req.user.id);
        if (!u || !u.active) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const token = signToken({
            sub: u.id,
            username: u.username,
            role: u.role,
            displayName: u.display_name,
            active_org_id: orgId
        });
        await logAudit(req, {
            action: 'auth.switch_org',
            outcome: 'success',
            targetType: 'org',
            targetId: orgId,
            metadata: { from: req.user.activeOrgId || null }
        });
        const orgs = await loadOrgsForUser(pool, { id: u.id, role: u.role });
        res.json({
            token,
            user: {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role,
                active_org_id: orgId
            },
            orgs
        });
    } catch (err) {
        console.error('[auth] switch-org', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/logout', (_req, res) => {
    res.json({ ok: true });
});

module.exports = router;
