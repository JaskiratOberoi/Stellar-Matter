'use strict';

/**
 * Phase 12: client_locations sync.
 *
 * Pulls Noble.dbo.tbl_med_mcc_unit_master via the Listec service's
 * GET /api/mcc-units endpoint and mirrors it into the `client_locations`
 * table in db-1 Postgres. MSSQL stays the source of truth; Postgres is a
 * derived index used by:
 *   - GET /api/regions (Tracer State -> City chips)
 *   - resolveClientCodes() in tracer's chip -> client_codes resolution
 *
 * Sync semantics:
 *   - Insert/update on (code) using a sha256 hash of the source row to skip
 *     no-op writes (so HOT path syncs are mostly index lookups).
 *   - Soft-delete: rows whose code disappears from MSSQL are flipped to
 *     active=false, never DELETE-d. This keeps any future FK from runs/
 *     audit_log intact and lets us see "code retired on YYYY-MM-DD" in the
 *     audit trail.
 *   - Single-row metadata table client_locations_sync gets every run's
 *     timing + counts so ops can spot a stuck sync without `SELECT count(*)`.
 *
 * Trigger surfaces:
 *   - Boot: scripts/lis-nav-bot/server.js fires runClientLocationsSync()
 *     after migrate() (logs + continues on failure).
 *   - Manual: POST /api/admin/client-locations/sync (super_admin only).
 *   - Optional interval: CLIENT_LOCATIONS_SYNC_INTERVAL_MIN (disabled by
 *     default; manual + boot is enough for most deploys).
 */

const crypto = require('node:crypto');
const { getPool, useDatabase } = require('../db/pool');

const DEFAULT_LISTEC_BASE = 'http://127.0.0.1:3100';

function listecApiBase() {
    return (process.env.LISTEC_API_BASE_URL || DEFAULT_LISTEC_BASE).replace(/\/$/, '');
}

/** Stable JSON serialisation for hashing (keys sorted). */
function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
    const keys = Object.keys(value).sort();
    return (
        '{' +
        keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') +
        '}'
    );
}

function hashRow(row) {
    return crypto.createHash('sha256').update(stableStringify(row)).digest('hex');
}

async function fetchMccUnits() {
    const url = `${listecApiBase()}/api/mcc-units`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Listec /api/mcc-units returned ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = await res.json();
    if (!json || !Array.isArray(json.rows)) {
        throw new Error(`Listec /api/mcc-units returned unexpected payload (no rows array)`);
    }
    return json.rows;
}

/**
 * Run one sync cycle. Safe to call concurrently with itself — the database
 * advisory lock below serialises against duplicate sync runs (e.g. boot vs
 * a manual POST landing at the same time).
 *
 * @param {{ logger?: { info?: (msg: string) => void, warn?: (msg: string) => void, error?: (msg: string) => void } }} [opts]
 * @returns {Promise<{ ok: true, rowsSeen: number, rowsUpserted: number, rowsDeleted: number, durationMs: number } | { ok: false, error: string }>}
 */
async function runClientLocationsSync(opts = {}) {
    if (!useDatabase()) {
        return { ok: false, error: 'DATABASE_URL not set; client_locations sync skipped.' };
    }
    const log = opts.logger || console;
    const started = Date.now();
    const pool = getPool();
    const client = await pool.connect();
    let lockAcquired = false;

    try {
        // Advisory lock keyed to the literal "client_locations_sync". Two
        // concurrent boot/manual syncs would otherwise race on the soft-delete
        // step (both seeing the same `seen` set). pg_try_advisory_lock returns
        // false instantly so we can no-op the second runner.
        const lockKey = 5810; // arbitrary stable int; not used elsewhere
        const lock = await client.query('SELECT pg_try_advisory_lock($1) AS got', [lockKey]);
        lockAcquired = Boolean(lock.rows[0] && lock.rows[0].got);
        if (!lockAcquired) {
            return { ok: false, error: 'Another client_locations sync is already in progress.' };
        }

        await client.query(
            `INSERT INTO client_locations_sync (id, last_run_at)
             VALUES (1, NOW())
             ON CONFLICT (id) DO UPDATE SET last_run_at = NOW(), last_error = NULL`
        );

        const rows = await fetchMccUnits();
        const rowsSeen = rows.length;
        const seenCodes = new Set();
        let rowsUpserted = 0;

        for (const row of rows) {
            const code = String(row.code || '').trim().toUpperCase();
            if (!code) continue;
            seenCodes.add(code);

            const hash = hashRow(row);
            const result = await client.query(
                `INSERT INTO client_locations (
                    code, name, business_unit_code, business_unit_name,
                    city_raw, city_key, city_label,
                    state_raw, state_key, state_label,
                    mobile, rate_label, report_flag, sub_codes,
                    active, synced_at, source_row_hash
                 ) VALUES (
                    $1, $2, $3, $4,
                    $5, $6, $7,
                    $8, $9, $10,
                    $11, $12, $13, $14,
                    true, NOW(), $15
                 )
                 ON CONFLICT (code) DO UPDATE SET
                    name               = EXCLUDED.name,
                    business_unit_code = EXCLUDED.business_unit_code,
                    business_unit_name = EXCLUDED.business_unit_name,
                    city_raw           = EXCLUDED.city_raw,
                    city_key           = EXCLUDED.city_key,
                    city_label         = EXCLUDED.city_label,
                    state_raw          = EXCLUDED.state_raw,
                    state_key          = EXCLUDED.state_key,
                    state_label        = EXCLUDED.state_label,
                    mobile             = EXCLUDED.mobile,
                    rate_label         = EXCLUDED.rate_label,
                    report_flag        = EXCLUDED.report_flag,
                    sub_codes          = EXCLUDED.sub_codes,
                    active             = true,
                    synced_at          = NOW(),
                    source_row_hash    = EXCLUDED.source_row_hash
                 WHERE client_locations.source_row_hash IS DISTINCT FROM EXCLUDED.source_row_hash
                    OR client_locations.active = false
                 RETURNING xmax = 0 AS inserted`,
                [
                    code,
                    row.name ?? null,
                    row.businessUnitCode ?? null,
                    row.businessUnitName ?? null,
                    row.cityRaw ?? null,
                    row.cityKey ?? null,
                    row.cityLabel ?? null,
                    row.stateRaw ?? null,
                    row.stateKey ?? null,
                    row.stateLabel ?? null,
                    row.mobile ?? null,
                    row.rateLabel ?? null,
                    row.reportFlag ?? null,
                    row.subCodes ?? null,
                    hash
                ]
            );
            if (result.rowCount > 0) rowsUpserted++;
        }

        // Soft-delete: any active code missing from this dump is now stale.
        // Pass the seen set as an array literal (chunked? not necessary for
        // ~10k codes — pg's text-array param handles 100k easily).
        let rowsDeleted = 0;
        if (seenCodes.size > 0) {
            const codesArray = [...seenCodes];
            const del = await client.query(
                `UPDATE client_locations
                    SET active = false, synced_at = NOW()
                  WHERE active = true
                    AND code <> ALL($1::text[])`,
                [codesArray]
            );
            rowsDeleted = del.rowCount || 0;
        } else {
            // Defensive: an empty MSSQL response shouldn't wipe Postgres. Log
            // and skip the soft-delete step if Listec returned zero rows.
            if (log.warn) log.warn('[client_locations] Listec returned 0 rows; skipping soft-delete.');
        }

        const durationMs = Date.now() - started;
        await client.query(
            `UPDATE client_locations_sync SET
                last_success_at = NOW(),
                last_error      = NULL,
                rows_seen       = $1,
                rows_upserted   = $2,
                rows_deleted    = $3
              WHERE id = 1`,
            [rowsSeen, rowsUpserted, rowsDeleted]
        );

        if (log.info) {
            log.info(
                `[client_locations] sync ok: seen=${rowsSeen} upserted=${rowsUpserted} soft-deleted=${rowsDeleted} (${durationMs} ms)`
            );
        }
        return { ok: true, rowsSeen, rowsUpserted, rowsDeleted, durationMs };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            await client.query(
                `UPDATE client_locations_sync SET last_error = $1 WHERE id = 1`,
                [msg]
            );
        } catch {
            /* metadata update best-effort */
        }
        if (log.error) log.error(`[client_locations] sync failed: ${msg}`);
        return { ok: false, error: msg };
    } finally {
        if (lockAcquired) {
            try {
                await client.query('SELECT pg_advisory_unlock($1)', [5810]);
            } catch {
                /* ignore */
            }
        }
        client.release();
    }
}

/** Read the metadata row for /health-style endpoints. */
async function getClientLocationsSyncStatus() {
    if (!useDatabase()) return null;
    const pool = getPool();
    const r = await pool.query(
        `SELECT id, last_run_at, last_success_at, last_error,
                rows_seen, rows_upserted, rows_deleted
         FROM client_locations_sync WHERE id = 1`
    );
    return r.rows[0] || null;
}

let intervalHandle = null;

/**
 * Start a periodic sync if CLIENT_LOCATIONS_SYNC_INTERVAL_MIN is set to a
 * positive integer. Idempotent — returns the existing handle if already
 * scheduled. Safe to call from the boot path.
 */
function startClientLocationsSyncInterval(opts = {}) {
    if (intervalHandle) return intervalHandle;
    const raw = process.env.CLIENT_LOCATIONS_SYNC_INTERVAL_MIN;
    const minutes = Number(raw);
    if (!Number.isFinite(minutes) || minutes <= 0) return null;
    const ms = Math.floor(minutes * 60_000);
    intervalHandle = setInterval(() => {
        runClientLocationsSync(opts).catch((e) => {
            // already logged inside runClientLocationsSync; double-catch keeps the
            // interval alive across transient failures.
            const log = opts.logger || console;
            if (log.error) log.error(`[client_locations] interval tick error: ${e}`);
        });
    }, ms);
    if (typeof intervalHandle.unref === 'function') intervalHandle.unref();
    return intervalHandle;
}

function stopClientLocationsSyncInterval() {
    if (intervalHandle) {
        clearInterval(intervalHandle);
        intervalHandle = null;
    }
}

module.exports = {
    runClientLocationsSync,
    getClientLocationsSyncStatus,
    startClientLocationsSyncInterval,
    stopClientLocationsSyncInterval
};
