'use strict';

// Lifted from Stellar-Shark/server/auth.js. Roles changed to the Stellar
// Matter roles: super_admin / admin / operator / viewer. JWT_SECRET must be set in
// production — falls back to an obvious dev secret only when NODE_ENV !== 'production'.
//
// Phase 10 adds active_org_id to the JWT plus loadOrgsForUser /
// pickInitialActiveOrg helpers consumed by authApi.

const jwt = require('jsonwebtoken');
const { useDatabase } = require('./db/pool');

function getJwtSecret() {
    const s = process.env.JWT_SECRET;
    if (s && String(s).trim()) return String(s).trim();
    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set in production');
    }
    return 'stellar-matter-dev-jwt-secret-change-me';
}

function signToken(payload) {
    return jwt.sign(payload, getJwtSecret(), { expiresIn: '7d' });
}

function verifyToken(token) {
    return jwt.verify(token, getJwtSecret());
}

function extractBearer(req) {
    const h = req.headers && req.headers.authorization;
    if (!h || typeof h !== 'string') return null;
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}

/**
 * When DATABASE_URL is not set we treat the app as open (legacy single-user mode).
 * When set, every gated route requires a valid JWT.
 */
function requireAuth(req, res, next) {
    if (!useDatabase()) {
        req.user = null;
        return next();
    }
    const token = extractBearer(req);
    if (!token) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const decoded = verifyToken(token);
        req.user = {
            id: decoded.sub,
            username: decoded.username,
            role: decoded.role,
            displayName: decoded.displayName,
            // active_org_id is stamped at login (and re-stamped by /switch-org).
            // Old tokens minted before Phase 10 lack it; downstream code falls
            // back to 'org-default' so existing dashboards keep working.
            activeOrgId: decoded.active_org_id || decoded.activeOrgId || null
        };
        return next();
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireRole(...roles) {
    return (req, res, next) => {
        if (!useDatabase()) return next();
        if (!req.user) return res.status(401).json({ error: 'Authentication required' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
        return next();
    };
}

async function loadUserById(client, id) {
    const r = await client.query(
        `SELECT id, username, display_name, role, active FROM users WHERE id = $1`,
        [id]
    );
    return r.rows[0] || null;
}

/**
 * Returns the orgs a user can act on. super_admin sees every active org so
 * the topbar switcher works; everyone else sees only their assignments.
 */
async function loadOrgsForUser(client, user) {
    if (!user) return [];
    if (user.role === 'super_admin') {
        const r = await client.query(
            `SELECT o.id, o.slug, o.name, o.active,
                    COALESCE(a.role, 'org_admin') AS membership_role
             FROM organizations o
             LEFT JOIN user_org_assignments a
               ON a.org_id = o.id AND a.user_id = $1
             WHERE o.active = true
             ORDER BY o.name`,
            [user.id]
        );
        return r.rows;
    }
    const r = await client.query(
        `SELECT o.id, o.slug, o.name, o.active, a.role AS membership_role
         FROM user_org_assignments a
         JOIN organizations o ON o.id = a.org_id
         WHERE a.user_id = $1 AND o.active = true
         ORDER BY o.name`,
        [user.id]
    );
    return r.rows;
}

/**
 * Picks the active org for a fresh login. Prefers an existing assignment
 * (alphabetical by name); for a super_admin with zero assignments it falls
 * back to any active org, then to 'org-default' as a last resort.
 */
async function pickInitialActiveOrg(client, user) {
    const orgs = await loadOrgsForUser(client, user);
    if (orgs.length > 0) return orgs[0].id;
    if (user && user.role === 'super_admin') {
        const r = await client.query(
            `SELECT id FROM organizations WHERE active = true ORDER BY name LIMIT 1`
        );
        if (r.rows.length) return r.rows[0].id;
    }
    return 'org-default';
}

module.exports = {
    getJwtSecret,
    signToken,
    verifyToken,
    extractBearer,
    requireAuth,
    requireRole,
    loadUserById,
    loadOrgsForUser,
    pickInitialActiveOrg
};
