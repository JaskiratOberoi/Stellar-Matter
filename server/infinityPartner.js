'use strict';

// The Stellar Infinity bridge: Infinity's API raises material requests here
// on behalf of its signed-in users, the same keyed-partner pattern Infinity
// itself offers Biosentry and Sense. One shared key, held by both servers,
// presented on every call as X-Infinity-Key; the request is stamped
// source='infinity' with the Infinity user, centre and region in source_meta,
// and the portal shows those rows with the Infinity mark.
//
// Nothing here touches the user JWT flow or the public code-gated form: the
// routes live under /api/material-requests/infinity/* and the server's auth
// wedge lets that prefix through to this middleware instead.
//
//   MATTER_INFINITY_KEY     the shared key (empty = bridge off, 503)
//   MATTER_INFINITY_ORG_ID  the org Infinity's requests belong to
//                           (default org-default, Qugen Pathlabs)

const crypto = require('crypto');

const HEADER = 'x-infinity-key';

function configuredKey() {
    return (process.env.MATTER_INFINITY_KEY || '').trim();
}

function infinityOrgId() {
    return (process.env.MATTER_INFINITY_ORG_ID || '').trim() || 'org-default';
}

function keyMatches(presented, expected) {
    if (!presented || !expected) return false;
    // Compare digests so the lengths always match and the comparison is
    // constant-time whatever was presented.
    const a = crypto.createHash('sha256').update(String(presented)).digest();
    const b = crypto.createHash('sha256').update(String(expected)).digest();
    return crypto.timingSafeEqual(a, b);
}

function requireInfinityKey(req, res, next) {
    const expected = configuredKey();
    if (!expected) {
        return res.status(503).json({ error: 'The Infinity bridge is not configured on this server.' });
    }
    const presented = (req.get(HEADER) || '').trim();
    if (!keyMatches(presented, expected)) {
        return res.status(401).json({ error: 'Unknown Infinity key.' });
    }
    req.infinity = { orgId: infinityOrgId() };
    return next();
}

module.exports = { HEADER, configuredKey, infinityOrgId, requireInfinityKey };
