'use strict';

/**
 * Phase 12: chip -> client_codes resolution.
 *
 * The Tracer Region chips (State and City) carry normalised keys produced by
 * `Listec/integration/node-mssql/regionAliases.ts`. When the user submits a
 * tracer run with a city/state chip selected, this helper turns those keys
 * back into the underlying MCCUnitCode list by reading the Postgres mirror
 * (`client_locations`) populated by syncClientLocations.js.
 *
 * Output is intentionally minimal — just `code` plus enough context (BU,
 * city/state keys, label) for the tracer fan-out to attribute results back
 * to the chip the user clicked.
 */

const { getPool, useDatabase } = require('../db/pool');

/**
 * @param {{ cityKeys?: string[], stateKeys?: string[], includeInactive?: boolean }} opts
 * @returns {Promise<Array<{ code: string, name: string|null, business_unit_code: string|null, business_unit_name: string|null, city_key: string|null, city_label: string|null, state_key: string|null, state_label: string|null }>>}
 */
async function resolveClientCodes(opts = {}) {
    if (!useDatabase()) return [];
    const cityKeys = Array.isArray(opts.cityKeys)
        ? [
              ...new Set(
                  opts.cityKeys
                      .map((k) => String(k || '').trim().toUpperCase())
                      .filter(Boolean)
              )
          ]
        : [];
    const stateKeys = Array.isArray(opts.stateKeys)
        ? [
              ...new Set(
                  opts.stateKeys
                      .map((k) => String(k || '').trim().toUpperCase())
                      .filter(Boolean)
              )
          ]
        : [];
    if (cityKeys.length === 0 && stateKeys.length === 0) return [];

    const pool = getPool();
    const activeFilter = opts.includeInactive ? '' : 'AND active = true';
    const r = await pool.query(
        `SELECT code, name, business_unit_code, business_unit_name,
                city_key, city_label, state_key, state_label
           FROM client_locations
          WHERE ( city_key = ANY($1::text[]) OR state_key = ANY($2::text[]) )
            ${activeFilter}
          ORDER BY code`,
        [cityKeys, stateKeys]
    );
    return r.rows;
}

/**
 * Group resolved rows by chip key so the caller can attribute SIDs/results
 * back to the originating chip (handy for banner subtitles like
 * "Haldwani: 23 codes, 4 BUs"). When a code matches both a selected city
 * AND a selected state it's listed under both buckets.
 *
 * @param {Awaited<ReturnType<typeof resolveClientCodes>>} rows
 * @param {{ cityKeys: string[], stateKeys: string[] }} sel
 */
function groupResolvedByChip(rows, sel) {
    const cities = sel.cityKeys || [];
    const states = sel.stateKeys || [];
    /** @type {Record<string, { codes: string[], businessUnitCodes: Set<string> }>} */
    const byChip = {};
    for (const k of cities) byChip[`city:${k}`] = { codes: [], businessUnitCodes: new Set() };
    for (const k of states) byChip[`state:${k}`] = { codes: [], businessUnitCodes: new Set() };

    for (const row of rows) {
        if (row.city_key && byChip[`city:${row.city_key}`]) {
            byChip[`city:${row.city_key}`].codes.push(row.code);
            if (row.business_unit_code) {
                byChip[`city:${row.city_key}`].businessUnitCodes.add(row.business_unit_code);
            }
        }
        if (row.state_key && byChip[`state:${row.state_key}`]) {
            byChip[`state:${row.state_key}`].codes.push(row.code);
            if (row.business_unit_code) {
                byChip[`state:${row.state_key}`].businessUnitCodes.add(row.business_unit_code);
            }
        }
    }

    /** @type {Record<string, { codes: string[], businessUnitCodes: string[] }>} */
    const out = {};
    for (const [k, v] of Object.entries(byChip)) {
        out[k] = {
            codes: [...new Set(v.codes)].sort(),
            businessUnitCodes: [...v.businessUnitCodes].sort()
        };
    }
    return out;
}

module.exports = {
    resolveClientCodes,
    groupResolvedByChip
};
