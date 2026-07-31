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
const { lookupGeo, normalizeIp } = require('./geoip');

// Set on the request once an explicit logAudit() call has covered it, so the
// catch-all middleware in auditRequest.js doesn't write a duplicate generic row.
const AUDITED = Symbol.for('stellarMatter.audited');

function clientIp(req) {
    if (!req) return null;
    let raw = null;
    if (typeof req.ip === 'string' && req.ip) raw = req.ip;
    else if (req.headers && req.headers['x-forwarded-for']) {
        raw = String(req.headers['x-forwarded-for']).split(',')[0].trim();
    } else if (req.connection && req.connection.remoteAddress) raw = req.connection.remoteAddress;
    return normalizeIp(raw);
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
    const ip = clientIp(req);

    if (req && typeof req === 'object') {
        try {
            req[AUDITED] = true;
        } catch {
            // Frozen/proxy request object — the worst case is a duplicate
            // generic row from the catch-all middleware.
        }
    }

    try {
        const r = await pool.query(
            `INSERT INTO audit_log
                (actor_id, actor_username, action, target_type, target_id,
                 outcome, ip, user_agent, "before", "after", metadata,
                 method, path, status_code)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING id`,
            [
                actorId,
                actorUsername,
                String(fields.action),
                fields.targetType != null ? String(fields.targetType) : null,
                fields.targetId != null ? String(fields.targetId) : null,
                outcome,
                ip,
                userAgent(req),
                safeJson(fields.before),
                safeJson(fields.after),
                safeJson(fields.metadata),
                fields.method != null ? String(fields.method) : req && req.method ? String(req.method) : null,
                fields.path != null ? String(fields.path).slice(0, 512) : requestPath(req),
                Number.isFinite(fields.statusCode) ? Math.floor(fields.statusCode) : null
            ]
        );
        if (r.rows.length && ip) {
            // Geo resolution can hit the network, so it happens after the row
            // is durable and outside the caller's await.
            enrichGeo(r.rows[0].id, ip);
        }
    } catch (err) {
        // Never let audit failure block the request that triggered it.
        console.error('[audit] insert failed:', err && err.message ? err.message : err);
    }
}

function requestPath(req) {
    if (!req) return null;
    const raw = req.originalUrl || req.url;
    if (!raw) return null;
    return String(raw).split('?')[0].slice(0, 512);
}

function enrichGeo(rowId, ip) {
    Promise.resolve()
        .then(() => lookupGeo(ip))
        .then((geo) => {
            if (!geo) return null;
            const pool = getPool();
            if (!pool) return null;
            return pool.query(`UPDATE audit_log SET geo = $1 WHERE id = $2`, [safeJson(geo), rowId]);
        })
        .catch((err) => {
            console.error('[audit] geo enrich failed:', err && err.message ? err.message : err);
        });
}

module.exports = { logAudit, AUDITED };
