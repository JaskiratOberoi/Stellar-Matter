'use strict';

// Lifted from Stellar-Shark/server/auth.js. Roles changed to the Stellar
// Matter set (super_admin / operator / viewer). JWT_SECRET must be set in
// production — falls back to an obvious dev secret only when NODE_ENV !== 'production'.

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
            displayName: decoded.displayName
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

module.exports = {
    getJwtSecret,
    signToken,
    verifyToken,
    extractBearer,
    requireAuth,
    requireRole,
    loadUserById
};
