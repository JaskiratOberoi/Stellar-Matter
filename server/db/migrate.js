'use strict';

// Phase 3 migration: bare-minimum schema for the auth surface.
// Phase 8 (runs in Postgres) — runs + run_packages tables. The on-disk
// out/run-*.json + out/run-*-packages.json files remain the canonical
// artefact (they survive `docker compose down -v` because they live on
// the bind-mounted host volume); Postgres is a derived index used by
// /api/runs/tiles + /api/runs/:id so the tile wall doesn't have to scan
// hundreds of files per request and so cross-org scoping can be done
// in the query layer instead of in JS. Backfill is idempotent — every
// run not yet in Postgres gets ingested at startup, and every fresh
// run is upserted right after lib/run.js writes its JSON.
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
const { DEFAULT_ORG_ID, DEFAULT_ORG_SLUG, DEFAULT_ORG_NAME } = require('./orgConstants');

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
                role TEXT NOT NULL CHECK (role IN ('super_admin', 'operator', 'viewer', 'admin')),
                created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                active BOOLEAN NOT NULL DEFAULT true
            );
        `);

        // Broaden users.role to include 'admin' (SQL-only dashboard users). Existing
        // DBs may still have a 3-value CHECK from before this migration — drop any
        // check on users whose definition mentions role, then re-add a single
        // canonical constraint. Idempotent on re-runs.
        await client.query(`
            DO $body$
            DECLARE
                r RECORD;
            BEGIN
                FOR r IN (
                    SELECT c.conname::text AS cname
                    FROM pg_constraint c
                    JOIN pg_class t ON t.oid = c.conrelid
                    JOIN pg_namespace n ON n.oid = t.relnamespace
                    WHERE n.nspname = 'public'
                      AND t.relname = 'users'
                      AND c.contype = 'c'
                      AND pg_get_constraintdef(c.oid) LIKE '%role%'
                ) LOOP
                    EXECUTE format('ALTER TABLE users DROP CONSTRAINT %I', r.cname);
                END LOOP;
            END
            $body$;
        `);
        await client.query(`
            ALTER TABLE users
            ADD CONSTRAINT users_role_check
            CHECK (role IN ('super_admin', 'operator', 'viewer', 'admin'));
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

        // Phase 8: runs + run_packages. id is the run's ISO-ish timestamp slug
        // (e.g. "2026-05-07T07-29-13-035Z") which is also the on-disk file
        // basename — so a run row maps 1:1 to out/run-<id>.json on disk.
        // org_id defaults to 'org-default' so legacy on-disk runs ingested
        // before Phase 10 stamping land in the same tenant as the seed user.
        await client.query(`
            CREATE TABLE IF NOT EXISTS runs (
                id TEXT PRIMARY KEY,
                org_id TEXT NOT NULL DEFAULT 'org-default'
                    REFERENCES organizations(id) ON DELETE RESTRICT,
                started_at TIMESTAMPTZ,
                finished_at TIMESTAMPTZ,
                source TEXT NOT NULL DEFAULT 'scrape',
                mode TEXT NOT NULL DEFAULT 'general',
                bu TEXT,
                from_date TEXT,
                to_date TEXT,
                from_hour INT,
                to_hour INT,
                dry_run BOOLEAN NOT NULL DEFAULT false,
                exit_code INT,
                errors_count INT NOT NULL DEFAULT 0,
                sids_count INT NOT NULL DEFAULT 0,
                unique_label_count INT NOT NULL DEFAULT 0,
                other_tests_row_count INT NOT NULL DEFAULT 0,
                total_printed_pages INT NOT NULL DEFAULT 0,
                envelopes_big INT NOT NULL DEFAULT 0,
                envelopes_small INT NOT NULL DEFAULT 0,
                envelopes_unknown INT NOT NULL DEFAULT 0,
                urine_containers JSONB,
                filter JSONB,
                filters_applied JSONB,
                filters_requested JSONB,
                paths JSONB,
                ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                source_file_mtime TIMESTAMPTZ
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS runs_org_started_idx
             ON runs (org_id, started_at DESC);`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS runs_started_idx
             ON runs (started_at DESC);`
        );
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS edta_vials JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS citrate_vials JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS s_heparin JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS l_heparin JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS lbc JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS flouride_vials JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS barcode JSONB`);
        await client.query(`ALTER TABLE runs ADD COLUMN IF NOT EXISTS serum JSONB`);

        // run_packages: one row per (run_id, label). position preserves the
        // count-desc ordering buildTileFromRunFiles() computes so the
        // dashboard can reproduce the top-50 list with a single ORDER BY.
        await client.query(`
            CREATE TABLE IF NOT EXISTS run_packages (
                run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                label TEXT NOT NULL,
                count INT NOT NULL DEFAULT 0,
                pages_per_report INT,
                envelope_kind TEXT NOT NULL DEFAULT 'small'
                    CHECK (envelope_kind IN ('small', 'big')),
                envelope_estimated BOOLEAN NOT NULL DEFAULT false,
                position INT NOT NULL DEFAULT 0,
                PRIMARY KEY (run_id, label)
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS run_packages_run_position_idx
             ON run_packages (run_id, position);`
        );

        // Phase 12 (client_locations) — local mirror of
        // Noble.dbo.tbl_med_mcc_unit_master so the Tracer Region (State -> City)
        // chips, the chip-to-client_codes resolver, and any future cross-org
        // reporting can be answered from Postgres without a per-request hop to
        // the Listec MSSQL pool. The mirror is populated by
        // server/sync/syncClientLocations.js (boot + on-demand). MSSQL stays
        // the source of truth; Postgres is a derived index.
        //
        // city_key/state_key are the same normalised tokens that
        // Listec/integration/node-mssql/regionAliases.ts produces, so chip
        // payloads (LS_TRACER_REGION_SELECTION, /api/regions) keep working
        // byte-for-byte after the cutover.
        await client.query(`
            CREATE TABLE IF NOT EXISTS client_locations (
                code TEXT PRIMARY KEY,
                name TEXT,
                business_unit_code TEXT,
                business_unit_name TEXT,
                city_raw TEXT,
                city_key TEXT,
                city_label TEXT,
                state_raw TEXT,
                state_key TEXT,
                state_label TEXT,
                mobile TEXT,
                rate_label TEXT,
                report_flag TEXT,
                sub_codes TEXT,
                active BOOLEAN NOT NULL DEFAULT true,
                synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                source_row_hash TEXT NOT NULL
            );
        `);
        await client.query(
            `CREATE INDEX IF NOT EXISTS client_locations_city_key_idx
             ON client_locations (city_key) WHERE active = true;`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS client_locations_state_key_idx
             ON client_locations (state_key) WHERE active = true;`
        );
        await client.query(
            `CREATE INDEX IF NOT EXISTS client_locations_bu_idx
             ON client_locations (business_unit_code) WHERE active = true;`
        );

        // Single-row metadata table (id always = 1) so ops can see when the
        // last sync ran without scanning client_locations row-by-row.
        await client.query(`
            CREATE TABLE IF NOT EXISTS client_locations_sync (
                id INT PRIMARY KEY DEFAULT 1,
                last_run_at TIMESTAMPTZ,
                last_success_at TIMESTAMPTZ,
                last_error TEXT,
                rows_seen INT,
                rows_upserted INT,
                rows_deleted INT,
                CONSTRAINT client_locations_sync_singleton CHECK (id = 1)
            );
        `);
        await client.query(
            `INSERT INTO client_locations_sync (id) VALUES (1)
             ON CONFLICT (id) DO NOTHING;`
        );

        // Inventory tracker — stock-on-hand tracking that runs alongside the
        // usage-measurement side (runs/tiles). Three tables plus a derived
        // balances view: inventory_movements is an append-only ledger and
        // inventory_balances sums it, so on-hand can never drift from history.
        // org_id mirrors runs (default 'org-default', RESTRICT delete) so the
        // module is tenant-scoped without touching legacy single-org deploys.
        await migrateInventory(client);

        // Fold any legacy "Default" / duplicate acme-labs org into the single
        // canonical tenant so the org switcher only shows Qugen Pathlabs.
        await consolidateDefaultOrg(client);
    } finally {
        client.release();
    }
}

// Merge a separately-created acme-labs org (from the admin UI) into org-default
// and rename the canonical row to Qugen Pathlabs. Idempotent — safe on every boot.
async function consolidateDefaultOrg(client) {
    const dup = await client.query(
        `SELECT id FROM organizations WHERE slug = $1 AND id <> $2`,
        [DEFAULT_ORG_SLUG, DEFAULT_ORG_ID]
    );

    for (const { id: dupId } of dup.rows) {
        await client.query(`UPDATE runs SET org_id = $1 WHERE org_id = $2`, [DEFAULT_ORG_ID, dupId]);

        // Drop the auto-seeded catalog on org-default so Qugen's materials/locations
        // can move over without (org_id, name) unique-index clashes.
        await client.query(`DELETE FROM inventory_movements WHERE org_id = $1`, [DEFAULT_ORG_ID]);
        await client.query(`DELETE FROM inventory_materials WHERE org_id = $1`, [DEFAULT_ORG_ID]);
        await client.query(`DELETE FROM inventory_locations WHERE org_id = $1`, [DEFAULT_ORG_ID]);

        await client.query(`UPDATE inventory_locations SET org_id = $1 WHERE org_id = $2`, [
            DEFAULT_ORG_ID,
            dupId
        ]);
        await client.query(`UPDATE inventory_materials SET org_id = $1 WHERE org_id = $2`, [
            DEFAULT_ORG_ID,
            dupId
        ]);
        await client.query(`UPDATE inventory_movements SET org_id = $1 WHERE org_id = $2`, [
            DEFAULT_ORG_ID,
            dupId
        ]);

        await client.query(
            `INSERT INTO user_org_assignments (user_id, org_id, role)
             SELECT user_id, $1, role FROM user_org_assignments WHERE org_id = $2
             ON CONFLICT (user_id, org_id) DO NOTHING`,
            [DEFAULT_ORG_ID, dupId]
        );
        await client.query(`DELETE FROM user_org_assignments WHERE org_id = $1`, [dupId]);
        await client.query(`DELETE FROM organizations WHERE id = $1`, [dupId]);
    }

    await client.query(`UPDATE organizations SET slug = $2, name = $3 WHERE id = $1`, [
        DEFAULT_ORG_ID,
        DEFAULT_ORG_SLUG,
        DEFAULT_ORG_NAME
    ]);

    // Drop the auto-seeded Central Store when real locations already exist.
    await client.query(
        `DELETE FROM inventory_locations
         WHERE org_id = $1 AND name = 'Central Store'
           AND EXISTS (
               SELECT 1 FROM inventory_locations l2
               WHERE l2.org_id = $1 AND l2.name <> 'Central Store'
           )`,
        [DEFAULT_ORG_ID]
    );
}

// ---------------------------------------------------------------------------
// Inventory tracker schema + seeds. Split into its own function to keep the
// main migrate() readable; it is still called from inside migrate()'s client
// so it shares the same connection and runs on every boot, idempotently.
// ---------------------------------------------------------------------------

// The standard catalog. The first block is linked to the dashboard metric kind
// whose usage it should eventually be compared against. Envelopes split into
// BIG/SMALL to match how tiles already report them; letterheads count sheets
// 1:1 with the dashboard's page metric. base_unit is the smallest countable
// item; packs are entered as pack_size x pack_qty and stored as base units.
//
// Everything after the metric-linked block is inventory-only: metricKind stays
// null so these consumables never surface as Tracer tiles or dashboard metrics.
const INVENTORY_MATERIAL_SEEDS = [
    { id: 'invmat-letterheads', name: 'Letter Heads', metricKind: 'letterheads', baseUnit: 'sheet', packSize: 500, packLabel: 'ream' },
    { id: 'invmat-envelopes-big', name: 'Envelopes (Big)', metricKind: 'envelopes', baseUnit: 'envelope', packSize: 100, packLabel: 'box' },
    { id: 'invmat-envelopes-small', name: 'Envelopes (Small)', metricKind: 'envelopes', baseUnit: 'envelope', packSize: 100, packLabel: 'box' },
    { id: 'invmat-urine-containers', name: 'Urine Containers', metricKind: 'urine_containers', baseUnit: 'container', packSize: 100, packLabel: 'box' },
    { id: 'invmat-edta-vials', name: 'EDTA Vials', metricKind: 'edta_vials', baseUnit: 'vial', packSize: 100, packLabel: 'box' },
    { id: 'invmat-flouride-vials', name: 'Flouride Vials', metricKind: 'flouride_vials', baseUnit: 'vial', packSize: 100, packLabel: 'box' },
    { id: 'invmat-citrate-vials', name: 'Citrate Vials', metricKind: 'citrate_vials', baseUnit: 'vial', packSize: 100, packLabel: 'box' },
    { id: 'invmat-s-heparin', name: 'S.Heparin', metricKind: 's_heparin', baseUnit: 'vial', packSize: 100, packLabel: 'box' },
    { id: 'invmat-l-heparin', name: 'L.Heparin', metricKind: 'l_heparin', baseUnit: 'vial', packSize: 100, packLabel: 'box' },
    { id: 'invmat-lbc', name: 'LBC', metricKind: 'lbc', baseUnit: 'sample', packSize: 50, packLabel: 'box' },
    { id: 'invmat-barcode-labels', name: 'Barcode Labels', metricKind: 'barcode', baseUnit: 'label', packSize: 1000, packLabel: 'roll' },
    { id: 'invmat-serum-tubes', name: 'Serum Tubes', metricKind: 'serum', baseUnit: 'tube', packSize: 100, packLabel: 'box' },

    // -- Tubes, vacuum tubes and containers --
    { id: 'invmat-multipurpose-tube', name: 'Multipurpose Tube', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-edta-vacuum', name: 'EDTA Vacuum', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-serum-vacuum', name: 'Serum Vacuum', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-flouride-vacuum', name: 'Flouride Vacuum', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-sst-tubes', name: 'SST Tubes', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-capillary-tube', name: 'Capillary Tube', metricKind: null, baseUnit: 'tube', packSize: 100, packLabel: 'box' },
    { id: 'invmat-caplin-jar', name: 'Caplin Jar', metricKind: null, baseUnit: 'jar', packSize: 100, packLabel: 'box' },

    // -- Stationery and paperwork --
    { id: 'invmat-noble-letterhead', name: 'Noble Letterhead', metricKind: null, baseUnit: 'sheet', packSize: 500, packLabel: 'ream' },
    { id: 'invmat-khetrapal-letterhead', name: 'Khetrapal Letterhead', metricKind: null, baseUnit: 'sheet', packSize: 500, packLabel: 'ream' },
    { id: 'invmat-samarpan-letterhead', name: 'Samarpan Letterhead', metricKind: null, baseUnit: 'sheet', packSize: 500, packLabel: 'ream' },
    { id: 'invmat-hemal-letterhead', name: 'Hemal Letterhead', metricKind: null, baseUnit: 'sheet', packSize: 500, packLabel: 'ream' },
    { id: 'invmat-trf-5-line', name: 'TRF - 5 Line', metricKind: null, baseUnit: 'form', packSize: 100, packLabel: 'pad' },
    { id: 'invmat-trf-big', name: 'TRF Big', metricKind: null, baseUnit: 'form', packSize: 100, packLabel: 'pad' },
    { id: 'invmat-trf-single-page', name: 'TRF Single Page', metricKind: null, baseUnit: 'form', packSize: 100, packLabel: 'pad' },
    { id: 'invmat-xray-envelopes', name: 'X-ray Envelopes', metricKind: null, baseUnit: 'envelope', packSize: 50, packLabel: 'pack' },
    { id: 'invmat-ziplock-bags', name: 'Ziplock Bags', metricKind: null, baseUnit: 'bag', packSize: 100, packLabel: 'pack' },

    // -- Phlebotomy consumables --
    { id: 'invmat-vacuum-needle', name: 'Vacuum Needle', metricKind: null, baseUnit: 'needle', packSize: 100, packLabel: 'box' },
    { id: 'invmat-syringe-1ml', name: 'Syringe 1ml', metricKind: null, baseUnit: 'syringe', packSize: 100, packLabel: 'box' },
    { id: 'invmat-syringe-3ml', name: 'Syringe 3ml', metricKind: null, baseUnit: 'syringe', packSize: 100, packLabel: 'box' },
    { id: 'invmat-syringe-5ml', name: 'Syringe 5ml', metricKind: null, baseUnit: 'syringe', packSize: 100, packLabel: 'box' },
    { id: 'invmat-syringe-10ml', name: 'Syringe 10ml', metricKind: null, baseUnit: 'syringe', packSize: 100, packLabel: 'box' },
    { id: 'invmat-cotton-roll', name: 'Cotton Roll', metricKind: null, baseUnit: 'roll', packSize: 1, packLabel: 'roll' },
    { id: 'invmat-bandages', name: 'Bandages', metricKind: null, baseUnit: 'piece', packSize: 100, packLabel: 'box' },
    { id: 'invmat-swab-sticks', name: 'Swab Sticks', metricKind: null, baseUnit: 'stick', packSize: 100, packLabel: 'pack' },

    // -- PPE, hygiene and waste --
    { id: 'invmat-gloves', name: 'Gloves', metricKind: null, baseUnit: 'pair', packSize: 100, packLabel: 'box' },
    { id: 'invmat-mask', name: 'Mask', metricKind: null, baseUnit: 'mask', packSize: 50, packLabel: 'box' },
    { id: 'invmat-spirit', name: 'Spirit', metricKind: null, baseUnit: 'bottle', packSize: 1, packLabel: 'bottle' },
    { id: 'invmat-sanitizer', name: 'Sanitizer', metricKind: null, baseUnit: 'bottle', packSize: 1, packLabel: 'bottle' },
    { id: 'invmat-sharp-container-blue', name: 'Sharp Container - Blue', metricKind: null, baseUnit: 'container', packSize: 1, packLabel: 'unit' },
    { id: 'invmat-sharp-container-white', name: 'Sharp Container - White', metricKind: null, baseUnit: 'container', packSize: 1, packLabel: 'unit' },
    { id: 'invmat-biowaste-polybags-yellow', name: 'Biowaste Polybags - Yellow', metricKind: null, baseUnit: 'bag', packSize: 100, packLabel: 'pack' },
    { id: 'invmat-biowaste-polybags-red', name: 'Biowaste Polybags - Red', metricKind: null, baseUnit: 'bag', packSize: 100, packLabel: 'pack' }
];

async function migrateInventory(client) {
    // Materials catalog. Free-form so ops can add consumables the dashboard
    // does not measure (gloves, slides); metric_kind is nullable and only set
    // for the ones that map to a tile kind.
    await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_materials (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org-default'
                REFERENCES organizations(id) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            sku TEXT,
            metric_kind TEXT,
            base_unit TEXT NOT NULL DEFAULT 'unit',
            default_pack_size INT NOT NULL DEFAULT 1 CHECK (default_pack_size > 0),
            default_pack_label TEXT,
            reorder_level INT NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        );
    `);
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_materials_org_idx
         ON inventory_materials (org_id) WHERE active = true;`
    );

    // Stock locations. 'store' is the central warehouse; 'business_unit' and
    // 'lab' are dispatch destinations that optionally carry the Listec bu_code
    // / client_code so a location can be tied back to the usage stats.
    await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_locations (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org-default'
                REFERENCES organizations(id) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            kind TEXT NOT NULL DEFAULT 'business_unit'
                CHECK (kind IN ('store', 'business_unit', 'lab')),
            bu_code TEXT,
            client_code TEXT,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        );
    `);
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_locations_org_idx
         ON inventory_locations (org_id) WHERE active = true;`
    );

    // Append-only ledger. Every row is a positive qty_base; direction is read
    // from from_location_id / to_location_id. Corrections use voided_at rather
    // than DELETE so the trail stays intact. pack_size/pack_qty are recorded
    // for receipts so "20 boxes of 100" is auditable even though qty_base is
    // the 2,000 that actually moves.
    await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
            id BIGSERIAL PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org-default'
                REFERENCES organizations(id) ON DELETE RESTRICT,
            material_id TEXT NOT NULL
                REFERENCES inventory_materials(id) ON DELETE RESTRICT,
            kind TEXT NOT NULL
                CHECK (kind IN ('receipt', 'dispatch', 'adjustment')),
            from_location_id TEXT REFERENCES inventory_locations(id) ON DELETE RESTRICT,
            to_location_id TEXT REFERENCES inventory_locations(id) ON DELETE RESTRICT,
            qty_base INT NOT NULL CHECK (qty_base > 0),
            pack_size INT CHECK (pack_size IS NULL OR pack_size > 0),
            pack_qty INT CHECK (pack_qty IS NULL OR pack_qty > 0),
            vendor TEXT,
            reference TEXT,
            note TEXT,
            occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_by TEXT,
            voided_at TIMESTAMPTZ,
            voided_by TEXT,
            -- A movement must touch at least one location; a dispatch touches two.
            CONSTRAINT inventory_movements_has_location
                CHECK (from_location_id IS NOT NULL OR to_location_id IS NOT NULL)
        );
    `);
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_movements_material_idx
         ON inventory_movements (org_id, material_id, occurred_at DESC);`
    );
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_movements_org_time_idx
         ON inventory_movements (org_id, occurred_at DESC);`
    );
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_movements_from_idx
         ON inventory_movements (from_location_id) WHERE from_location_id IS NOT NULL;`
    );
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_movements_to_idx
         ON inventory_movements (to_location_id) WHERE to_location_id IS NOT NULL;`
    );

    // Vendors we buy stock from. Free-form contact details; gst_number is stored
    // as given (trimmed/uppercased) rather than format-validated so unusual
    // registrations are not rejected. The materials a vendor supplies live in
    // the join table below so a receipt can suggest what they typically provide.
    await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_vendors (
            id TEXT PRIMARY KEY,
            org_id TEXT NOT NULL DEFAULT 'org-default'
                REFERENCES organizations(id) ON DELETE RESTRICT,
            name TEXT NOT NULL,
            contact_person TEXT,
            phone TEXT,
            email TEXT,
            address TEXT,
            gst_number TEXT,
            note TEXT,
            active BOOLEAN NOT NULL DEFAULT true,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name)
        );
    `);
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_vendors_org_idx
         ON inventory_vendors (org_id) WHERE active = true;`
    );

    // Which catalog materials each vendor supplies. Both sides cascade: dropping
    // a vendor or a material just removes the link, never a movement.
    await client.query(`
        CREATE TABLE IF NOT EXISTS inventory_vendor_materials (
            vendor_id TEXT NOT NULL REFERENCES inventory_vendors(id) ON DELETE CASCADE,
            material_id TEXT NOT NULL REFERENCES inventory_materials(id) ON DELETE CASCADE,
            PRIMARY KEY (vendor_id, material_id)
        );
    `);
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_vendor_materials_material_idx
         ON inventory_vendor_materials (material_id);`
    );

    // Link receipts back to a vendor entity. The legacy free-text vendor column
    // above stays for any historical rows; new receipts set vendor_id instead.
    await client.query(
        `ALTER TABLE inventory_movements
         ADD COLUMN IF NOT EXISTS vendor_id TEXT
             REFERENCES inventory_vendors(id) ON DELETE SET NULL;`
    );
    await client.query(
        `CREATE INDEX IF NOT EXISTS inventory_movements_vendor_idx
         ON inventory_movements (vendor_id) WHERE vendor_id IS NOT NULL;`
    );

    // Derived balances: inflows to a location minus outflows from it, ignoring
    // voided rows. Recreated idempotently so schema edits ship cleanly.
    await client.query(`
        CREATE OR REPLACE VIEW inventory_balances AS
        SELECT org_id, material_id, location_id, SUM(qty)::bigint AS on_hand
        FROM (
            SELECT org_id, material_id, to_location_id AS location_id, qty_base AS qty
                FROM inventory_movements
                WHERE voided_at IS NULL AND to_location_id IS NOT NULL
            UNION ALL
            SELECT org_id, material_id, from_location_id AS location_id, -qty_base AS qty
                FROM inventory_movements
                WHERE voided_at IS NULL AND from_location_id IS NOT NULL
        ) t
        GROUP BY org_id, material_id, location_id;
    `);

    // Seed the central store and catalog only for a fresh default org. Once ops
    // have set up real locations (e.g. via the starter catalog), skip re-seeding.
    const seeded = await client.query(
        `SELECT COUNT(*)::int AS c FROM inventory_locations WHERE org_id = $1`,
        [DEFAULT_ORG_ID]
    );
    if (seeded.rows[0].c === 0) {
        await client.query(
            `INSERT INTO inventory_locations (id, org_id, name, kind)
             VALUES ($1, $2, $3, 'store')
             ON CONFLICT (org_id, name) DO NOTHING`,
            ['invloc-central-store', DEFAULT_ORG_ID, 'Central Store']
        );
        for (const m of INVENTORY_MATERIAL_SEEDS) {
            await client.query(
                `INSERT INTO inventory_materials
                    (id, org_id, name, metric_kind, base_unit, default_pack_size, default_pack_label)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (org_id, name) DO NOTHING`,
                [m.id, DEFAULT_ORG_ID, m.name, m.metricKind, m.baseUnit, m.packSize, m.packLabel]
            );
        }
    }

    await backfillCatalogMaterials(client);
}

// Orgs that were seeded before a material joined the standard catalog would
// otherwise never see it, since the seed block above only runs for a fresh org.
// Top up every org that already has a catalog. Safe to repeat: names are unique
// per org, and disabling a material keeps the row, so nothing is resurrected.
async function backfillCatalogMaterials(client) {
    const orgs = await client.query(`SELECT DISTINCT org_id FROM inventory_materials`);
    for (const { org_id: orgId } of orgs.rows) {
        for (const m of INVENTORY_MATERIAL_SEEDS) {
            await client.query(
                `INSERT INTO inventory_materials
                    (id, org_id, name, metric_kind, base_unit, default_pack_size, default_pack_label)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (org_id, name) DO NOTHING`,
                [
                    `invmat-${crypto.randomBytes(8).toString('hex')}`,
                    orgId,
                    m.name,
                    m.metricKind,
                    m.baseUnit,
                    m.packSize,
                    m.packLabel
                ]
            );
        }
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

module.exports = { migrate, newUserId, INVENTORY_MATERIAL_SEEDS };

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
