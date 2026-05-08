'use strict';

// Phase 3 migration: bare-minimum schema for the auth surface.
// Phase 8 (runs in Postgres) will extend this file with runs/run_packages.
// Phase 9 (audit log) — append-only audit_log table with three indexes.
// Phase 10 (orgs) — organizations + user_org_assignments tables, with the
// default org seeded and every existing user auto-assigned to it.
//
// All migrations are idempotent (CREATE TABLE IF NOT EXISTS, INSERT ... ON
// CONFLICT DO NOTHING). On every server boot migrate() runs and quietly
// brings the schema forward.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { getPool, useDatabase } = require('./pool');

const SUPER_ADMIN_ID = 'user-super-admin';
const DEFAULT_ORG_ID = 'org-default';
const DEFAULT_ORG_SLUG = 'default';
const DEFAULT_ORG_NAME = 'Default';

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

        // audit_log: append-only. actor_id is nullable for failed logins where
        // we have a username string but no resolved user row. before/after are
        // jsonb so we can run jsonpath queries when investigating an incident.
        // metadata is a free-form jsonb bag (run id, target BU list, etc).
        await client.query(`
            CREATE TABLE IF NOT EXISTS audit_log (
                id BIGSERIAL PRIMARY KEY,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                actor_id TEXT,
                actor_username TEXT,
                action TEXT NOT NULL,
                target_type TEXT,
                target_id TEXT,
                outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
                ip TEXT,
                user_agent TEXT,
                "before" JSONB,
                "after" JSONB,
                metadata JSONB
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log (created_at DESC);`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS audit_log_action_idx ON audit_log (action, created_at DESC);`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor_id, created_at DESC);`
        );

        // organizations + user_org_assignments. The default org is seeded so
        // every existing user (and every existing on-disk run, by convention)
        // belongs to a real row instead of NULL. Single-org deployments simply
        // leave everyone in 'org-default'.
        await client.query(`
            CREATE TABLE IF NOT EXISTS organizations (
                id TEXT PRIMARY KEY,
                slug TEXT UNIQUE NOT NULL,
                name TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                active BOOLEAN NOT NULL DEFAULT true
            );
        `);
        await client.query(`
            CREATE TABLE IF NOT EXISTS user_org_assignments (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
                role TEXT NOT NULL CHECK (role IN ('member', 'org_admin')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                PRIMARY KEY (user_id, org_id)
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS user_org_assignments_org_idx
             ON user_org_assignments (org_id);`
        );

        // Seed the default org and auto-assign every existing non-admin user
        // to it. super_admin gets a separate INSERT in seedSuperAdmin() so
        // they land as 'org_admin' instead of 'member'. ON CONFLICT DO NOTHING
        // keeps this safe across re-runs.
        await client.query(
            `INSERT INTO organizations (id, slug, name)
             VALUES ($1, $2, $3)
             ON CONFLICT (id) DO NOTHING`,
            [DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_ORG_NAME]
        );
        await client.query(
            `INSERT INTO user_org_assignments (user_id, org_id, role)
             SELECT u.id, $1, 'member'
             FROM users u
             WHERE u.role <> 'super_admin'
               AND NOT EXISTS (
                   SELECT 1 FROM user_org_assignments a
                   WHERE a.user_id = u.id AND a.org_id = $1
               )`,
            [DEFAULT_ORG_ID]
        );
        // super_admins always belong to org-default as org_admin. UPSERT lifts
        // any pre-existing 'member' rows to 'org_admin' so a re-run heals
        // historical data.
        await client.query(
            `INSERT INTO user_org_assignments (user_id, org_id, role)
             SELECT u.id, $1, 'org_admin'
             FROM users u
             WHERE u.role = 'super_admin'
             ON CONFLICT (user_id, org_id) DO UPDATE SET role = 'org_admin'`,
            [DEFAULT_ORG_ID]
        );

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
    if (existing.rows.length > 0) {
        // The super_admin row exists; still ensure they have a default-org
        // assignment in case Phase 10 ran on a pre-existing seed.
        await client.query(
            `INSERT INTO user_org_assignments (user_id, org_id, role)
             VALUES ($1, $2, 'org_admin')
             ON CONFLICT (user_id, org_id) DO NOTHING`,
            [SUPER_ADMIN_ID, DEFAULT_ORG_ID]
        );
        return;
    }

    const passwordHash = bcrypt.hashSync(seed.password, 10);
    await client.query(
        `INSERT INTO users (id, username, password_hash, display_name, role, active)
         VALUES ($1, $2, $3, $4, 'super_admin', true)`,
        [SUPER_ADMIN_ID, seed.username, passwordHash, seed.displayName]
    );
    // Pin the super_admin into the default org as org_admin so the topbar org
    // switcher always has at least one assignment to show on first login.
    await client.query(
        `INSERT INTO user_org_assignments (user_id, org_id, role)
         VALUES ($1, $2, 'org_admin')
         ON CONFLICT (user_id, org_id) DO NOTHING`,
        [SUPER_ADMIN_ID, DEFAULT_ORG_ID]
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
