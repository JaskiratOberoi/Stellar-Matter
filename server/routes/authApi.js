'use strict';

// Lifted from Stellar-Shark/server/routes/authApi.js. Trimmed to the
// Stellar Matter user shape (no per-BU assignments yet — Phase 10 adds
// org assignments).

const express = require('express');
const bcrypt = require('bcryptjs');
const { getPool, useDatabase } = require('../db/pool');
const { signToken, requireAuth, loadUserById } = require('../auth');
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
        const token = signToken({
            sub: u.id,
            username: u.username,
            role: u.role,
            displayName: u.display_name
        });
        await logAudit(req, {
            action: 'auth.login',
            outcome: 'success',
            actorId: u.id,
            actorUsername: u.username,
            metadata: { role: u.role }
        });
        res.json({
            token,
            user: {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role
            }
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
        res.json({
            user: {
                id: u.id,
                username: u.username,
                display_name: u.display_name,
                role: u.role
            },
            guest: false
        });
    } catch (err) {
        console.error('[auth] me', err);
        res.status(500).json({ error: err.message || String(err) });
    }
});

router.post('/logout', (_req, res) => {
    res.json({ ok: true });
});

module.exports = router;
