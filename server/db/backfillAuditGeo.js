'use strict';

// One-off (re-runnable) backfill for audit_log rows written before the trail
// captured location.
//
// Two passes:
//   1. Normalise stored IPs — rows from behind the proxy were saved as
//      "1.2.3.4:56789" or "::ffff:10.0.0.4", which fragments the per-actor
//      address list and blocks geo lookups.
//   2. Resolve geo for every distinct IP that still has none.
//
// Public geolocation APIs rate-limit (ip-api's free tier allows ~45/min), so
// lookups are spaced out. Run with: npm run backfill:audit-geo

const { getPool, useDatabase } = require('./pool');
const { lookupGeo, normalizeIp } = require('../geoip');

const LOOKUP_SPACING_MS = 1500;

async function normalizeStoredIps(pool) {
    const r = await pool.query(
        `SELECT DISTINCT ip FROM audit_log
         WHERE ip IS NOT NULL AND (ip LIKE '::ffff:%' OR ip ~ '^[0-9.]+:[0-9]+$')`
    );
    let updated = 0;
    for (const { ip } of r.rows) {
        const clean = normalizeIp(ip);
        if (!clean || clean === ip) continue;
        const u = await pool.query(`UPDATE audit_log SET ip = $1 WHERE ip = $2`, [clean, ip]);
        updated += u.rowCount;
    }
    return { distinct: r.rows.length, rows: updated };
}

async function fillMissingGeo(pool) {
    const r = await pool.query(
        `SELECT ip, COUNT(*)::int AS rows FROM audit_log
         WHERE ip IS NOT NULL AND geo IS NULL
         GROUP BY ip ORDER BY COUNT(*) DESC`
    );
    let resolved = 0;
    let rows = 0;
    for (const [i, { ip }] of r.rows.entries()) {
        if (i > 0) await new Promise((res) => setTimeout(res, LOOKUP_SPACING_MS));
        const geo = await lookupGeo(ip);
        if (!geo) continue;
        const u = await pool.query(`UPDATE audit_log SET geo = $1 WHERE ip = $2 AND geo IS NULL`, [
            JSON.stringify(geo),
            ip
        ]);
        resolved += 1;
        rows += u.rowCount;
        console.log(`  ${ip} -> ${geo.label || geo.scope} (${u.rowCount} rows)`);
    }
    return { addresses: r.rows.length, resolved, rows };
}

async function backfillAuditGeo() {
    if (!useDatabase()) {
        throw new Error('DATABASE_URL is not set');
    }
    const pool = getPool();
    const norm = await normalizeStoredIps(pool);
    console.log(`[audit-geo] normalised ${norm.rows} row(s) across ${norm.distinct} malformed address(es)`);
    const geo = await fillMissingGeo(pool);
    console.log(
        `[audit-geo] resolved ${geo.resolved}/${geo.addresses} address(es), filled ${geo.rows} row(s)`
    );
    return { norm, geo };
}

module.exports = { backfillAuditGeo };

if (require.main === module) {
    require('dotenv').config();
    backfillAuditGeo()
        .then(() => process.exit(0))
        .catch((err) => {
            console.error('[audit-geo] failed:', err && err.message ? err.message : err);
            process.exit(1);
        });
}
