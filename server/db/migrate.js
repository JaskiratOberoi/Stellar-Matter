'use strict';

// Phase 3 migration: bare-minimum schema for the auth surface.
// Phase 8 (runs in Postgres) and Phase 10 (orgs) extend this file with
// runs/run_packages and organizations/user_org_assignments tables.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, useDatabase } = require('./pool');

const SUPER_ADMIN_ID = 'user-super-admin';

function readEnv(name, fallback) {
    const v = process.env[name];
    if (v != null && String(v).trim()) return String(v).trim();
    return fallback;
}

function envSeedConfig() {
    const username = readEnv('SUPER_ADMIN_USERNAME', null);
    const password = readEnv('SUPER_ADMIN_PASSWORD', null);
    const displayName = readEnv('SUPER_ADMIN_DISPLAY_NAME', 'Super Admin');
    if (!username || !password) {
        return null;
    }
    return { username, password, displayName };
}

async function migrate() {
    if (!useDatabase()) return;

    const pool = getPool();
    const client = await pool.connect();
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                display_name TEXT NOT NULL,
                role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'viewer')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                active BOOLEAN NOT NULL DEFAULT true
            );
        `);

        await seedSuperAdmin(client);
    } finally {
        client.release();
    }
}

async function seedSuperAdmin(client) {
    const seed = envSeedConfig();
    if (!seed) {
        // Quietly skip — admin can be inserted manually if env isn't set.
        // Production deploys must set SUPER_ADMIN_USERNAME / SUPER_ADMIN_PASSWORD.
        return;
    }
    const existing = await client.query(`SELECT 1 FROM users WHERE username = $1 LIMIT 1`, [seed.username]);
    if (existing.rows.length > 0) return;

    const passwordHash = bcrypt.hashSync(seed.password, 10);
    await client.query(
        `INSERT INTO users (id, username, password_hash, display_name, role, active)
         VALUES ($1, $2, $3, $4, 'super_admin', true)`,
        [SUPER_ADMIN_ID, seed.username, passwordHash, seed.displayName]
    );
    console.log(`[stellar-matter] seeded super_admin "${seed.username}"`);
}

function newUserId() {
    return `user-${crypto.randomBytes(8).toString('hex')}`;
}

module.exports = { migrate, newUserId };

if (require.main === module) {
    // CLI entrypoint: `node server/db/migrate.js`
    require('dotenv').config();
    migrate()
        .then(() => {
            console.log('[stellar-matter] migration complete');
            process.exit(0);
        })
        .catch((err) => {
            console.error('[stellar-matter] migration failed', err);
            process.exit(1);
        });
}
