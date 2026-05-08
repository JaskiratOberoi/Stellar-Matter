'use strict';

// Audit logger. One job: write a row to audit_log without ever crashing the
// caller. Errors are logged to stderr and swallowed — a downed audit table
// must never block a login or an admin action.
//
// Shape:
//
//   await logAudit(req, {
//       action: 'admin.user.create',
//       targetType: 'user',
//       targetId: created.id,
//       outcome: 'success',
//       before: null,                // null for creates
//       after: { username, role },
//       metadata: { source: 'admin_panel' }
//   });
//
// req is the Express request so we can pull actor + ip + user-agent without
// the caller restating them. If req is null (e.g. background jobs) pass an
// object with { user, ip, userAgent } shaped like a request.

const { getPool, useDatabase } = require('./db/pool');

function clientIp(req) {
    if (!req) return null;
    if (typeof req.ip === 'string' && req.ip) return req.ip;
    if (req.headers && req.headers['x-forwarded-for']) {
        return String(req.headers['x-forwarded-for']).split(',')[0].trim();
    }
    if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
    return null;
}

function userAgent(req) {
    if (!req || !req.headers) return null;
    const ua = req.headers['user-agent'];
    return ua ? String(ua).slice(0, 512) : null;
}

function safeJson(v) {
    if (v == null) return null;
    try {
        // Stringify-then-parse normalises Maps, undefined, etc. and proves the
        // value is JSON-serialisable before it hits jsonb.
        return JSON.parse(JSON.stringify(v));
    } catch {
        return null;
    }
}

async function logAudit(req, fields) {
    if (!useDatabase()) return;
    const pool = getPool();
    if (!pool) return;
    if (!fields || !fields.action) return;

    const actorId =
        fields.actorId != null
            ? fields.actorId
            : req && req.user && req.user.id != null
            ? req.user.id
            : null;
    const actorUsername =
        fields.actorUsername != null
            ? fields.actorUsername
            : req && req.user && req.user.username != null
            ? req.user.username
            : null;
    const outcome = fields.outcome === 'failure' ? 'failure' : 'success';

    try {
        await pool.query(
            `INSERT INTO audit_log
                (actor_id, actor_username, action, target_type, target_id,
                 outcome, ip, user_agent, "before", "after", metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                actorId,
                actorUsername,
                String(fields.action),
                fields.targetType != null ? String(fields.targetType) : null,
                fields.targetId != null ? String(fields.targetId) : null,
                outcome,
                clientIp(req),
                userAgent(req),
                safeJson(fields.before),
                safeJson(fields.after),
                safeJson(fields.metadata)
            ]
        );
    } catch (err) {
        // Never let audit failure block the request that triggered it.
        console.error('[audit] insert failed:', err && err.message ? err.message : err);
    }
}

module.exports = { logAudit };
