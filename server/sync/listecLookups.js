'use strict';

const DEFAULT_LISTEC_BASE = 'http://127.0.0.1:3100';

function listecApiBase() {
    return (process.env.LISTEC_API_BASE_URL || DEFAULT_LISTEC_BASE).replace(/\/$/, '');
}

function normalizeBusinessUnits(list) {
    if (!Array.isArray(list)) return [];
    return list
        .map((row) => {
            if (typeof row === 'string') {
                const label = row.trim();
                return label ? { code: label, name: label } : null;
            }
            const name = String(row.name || row.label || row.id || '').trim();
            const code = row.id != null ? String(row.id).trim() : name;
            return name ? { code, name } : null;
        })
        .filter(Boolean);
}

async function fetchListecLookups() {
    try {
        const r = await fetch(`${listecApiBase()}/api/lookups`, { headers: { Accept: 'application/json' } });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return await r.json();
    } catch (err) {
        return {
            businessUnits: [],
            statuses: [],
            departments: [],
            error: String(err && err.message ? err.message : err)
        };
    }
}

/** Same business-unit list served by GET /api/bu (Listec lookups, not client_locations). */
async function fetchBusinessUnits() {
    const j = await fetchListecLookups();
    return normalizeBusinessUnits(j.businessUnits);
}

module.exports = { fetchListecLookups, fetchBusinessUnits, normalizeBusinessUnits };
