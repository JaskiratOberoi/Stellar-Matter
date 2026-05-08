'use strict';

// Lifted from Stellar-Shark/server/db/pool.js. Same shape so future
// Phase 8 (runs in Postgres) can reuse the helper.

const { Pool } = require('pg');

/** @type {import('pg').Pool | null} */
let pool = null;

function useDatabase() {
    return Boolean(process.env.DATABASE_URL && String(process.env.DATABASE_URL).trim());
}

function getPool() {
    if (!useDatabase()) {
        throw new Error('DATABASE_URL is not set');
    }
    if (!pool) {
        pool = new Pool({
            connectionString: process.env.DATABASE_URL,
            max: 10,
            idleTimeoutMillis: 30_000
        });
    }
    return pool;
}

async function closePool() {
    if (pool) {
        const p = pool;
        pool = null;
        await p.end();
    }
}

module.exports = { getPool, closePool, useDatabase };
