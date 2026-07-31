'use strict';

// Catch-all request auditing.
//
// The hand-written logAudit() calls in the route handlers capture rich
// before/after detail for the actions we care most about (logins, user and org
// mutations, inventory movements, run starts). This middleware is the safety
// net underneath them: any state-changing API call that no handler explicitly
// audited still lands in the trail, so "what did this user do?" has a complete
// answer rather than a curated one.
//
// It runs on response finish, and skips a request that logAudit() already
// covered (marked via the AUDITED symbol) so rich rows are never shadowed by a
// generic duplicate.

const { logAudit, AUDITED } = require('./audit');
const { useDatabase } = require('./db/pool');

const IGNORED_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Endpoints whose traffic is either pure noise or already fully audited by the
// handler that serves them.
const IGNORED_PATHS = [/^\/api\/health$/, /^\/api\/auth\/me$/];

function pathOf(req) {
    const raw = req.originalUrl || req.url || '';
    return String(raw).split('?')[0];
}

function shouldSkip(req) {
    const p = pathOf(req);
    if (!p.startsWith('/api/')) return true;
    if (IGNORED_METHODS.has(req.method)) return true;
    if (IGNORED_PATHS.some((re) => re.test(p))) return true;
    return false;
}

function auditRequests() {
    return function auditRequestMiddleware(req, res, next) {
        if (!useDatabase() || shouldSkip(req)) return next();

        res.on('finish', () => {
            if (req[AUDITED]) return;
            const status = res.statusCode;
            // Anonymous traffic is only worth recording when it was rejected —
            // that is an access attempt. Successful anonymous calls are public
            // endpoints and would just flood the trail.
            const rejected = status === 401 || status === 403;
            if (!req.user && !rejected) return;

            logAudit(req, {
                action: `api.${String(req.method).toLowerCase()}`,
                targetType: 'endpoint',
                targetId: pathOf(req),
                outcome: status >= 400 ? 'failure' : 'success',
                statusCode: status,
                metadata: { auto: true, query: sanitizeQuery(req.query) }
            });
        });

        return next();
    };
}

// Query strings can carry secrets in badly-shaped clients; keep keys and drop
// anything that looks sensitive.
const SENSITIVE_KEY = /pass|token|secret|auth|key/i;

function sanitizeQuery(query) {
    if (!query || typeof query !== 'object') return undefined;
    const keys = Object.keys(query);
    if (!keys.length) return undefined;
    const out = {};
    for (const k of keys.slice(0, 20)) {
        out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : String(query[k]).slice(0, 200);
    }
    return out;
}

module.exports = { auditRequests };
