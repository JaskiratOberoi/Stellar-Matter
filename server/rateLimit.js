'use strict';

// Centralised express-rate-limit factories. Two flavours:
//
//   loginLimiter      — 5 requests / minute per IP, used on POST /api/auth/login
//                       to slow brute-force attempts against the login endpoint.
//
//   adminWriteLimiter — 30 requests / minute per authenticated user, used on
//                       mutating /api/admin/* routes (POST / PATCH / DELETE).
//                       Keyed by req.user.id because every admin caller is
//                       authenticated by the time this middleware runs.
//
// Both responses set `Retry-After` (in seconds) and return a JSON body in the
// same shape as the rest of the API so the SPA error handler doesn't need a
// special case for 429s.
//
// Trust-proxy: the legacy server (scripts/lis-nav-bot/server.js) calls
// `app.set('trust proxy', 1)` so req.ip reflects the X-Forwarded-For value
// Caddy sets, not the docker bridge gateway address.

const rateLimit = require('express-rate-limit');

const ONE_MINUTE_MS = 60 * 1000;

function buildHandler(label) {
    return (req, res, _next, options) => {
        const retryAfterSec = Math.max(1, Math.ceil(options.windowMs / 1000));
        res
            .status(options.statusCode)
            .set('Retry-After', String(retryAfterSec))
            .json({
                error: `Too many ${label} requests. Please retry in ${retryAfterSec}s.`,
                retry_after_seconds: retryAfterSec
            });
    };
}

const loginLimiter = rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: buildHandler('login')
});

const adminWriteLimiter = rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // Key by user id (req.user is set by requireAuth which runs before this).
    // Fall back to IP if for some reason req.user is missing — defensive only,
    // adminApi mounts requireAuth at the router level so this should not happen.
    keyGenerator: (req) => (req.user && req.user.id) || req.ip || 'anon',
    handler: buildHandler('admin')
});

module.exports = {
    loginLimiter,
    adminWriteLimiter
};
