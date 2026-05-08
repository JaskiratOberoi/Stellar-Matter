#!/usr/bin/env node
'use strict';

/**
 * Hostinger DNS upsert utility.
 *
 * Reads HOSTINGER_API_KEY from process.env (.env via dotenv) and idempotently
 * creates or updates DNS records on developers.hostinger.com so the
 * matter.stellarinfomatica.com (and api-matter.stellarinfomatica.com)
 * subdomains point at this server.
 *
 * Usage:
 *   node scripts/hostinger-dns.cjs \
 *     --domain stellarinfomatica.com \
 *     --record matter,api-matter \
 *     --type A \
 *     --value 203.0.113.42
 *
 *   node scripts/hostinger-dns.cjs \
 *     --domain stellarinfomatica.com \
 *     --record api-matter \
 *     --type CNAME \
 *     --value matter.stellarinfomatica.com.
 *
 *   # Apex (@) records require BOTH flags. Without --force we refuse to
 *   # overwrite an existing apex record because that's how an entire domain
 *   # gets parked accidentally.
 *   node scripts/hostinger-dns.cjs \
 *     --domain stellarinfomatica.com \
 *     --record @ \
 *     --type A \
 *     --value 203.0.113.42 \
 *     --allow-apex --force
 *
 * The .cjs extension keeps Node treating this as CommonJS even though the
 * root package.json sets "type": "module" for the SPA tooling.
 *
 * Shape of the Hostinger v2 DNS API:
 *   GET  /api/dns/v1/zones/{domain}/records          -> list
 *   POST /api/dns/v1/zones/{domain}/records          -> create
 *   PUT  /api/dns/v1/zones/{domain}/records/{id}     -> update
 *
 * Note: Stellar-Shark does not have a DNS automation script today (only
 * GitHub Actions for SPA deploy). This is the first DNS automation in the
 * shared Stellar toolchain — keep it small and dependency-free.
 */

const path = require('node:path');
const fs = require('node:fs');

function loadEnv() {
    // Best-effort dotenv load. We don't hard-require dotenv so this script
    // also runs from environments where dotenv isn't installed (e.g. CI).
    try {
        const dotenvPath = path.resolve(__dirname, '..', '.env');
        if (fs.existsSync(dotenvPath)) {
            const raw = fs.readFileSync(dotenvPath, 'utf8');
            for (const line of raw.split(/\r?\n/)) {
                const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line);
                if (!m) continue;
                if (process.env[m[1]] != null) continue;
                let val = m[2];
                if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                    val = val.slice(1, -1);
                }
                process.env[m[1]] = val;
            }
        }
    } catch {
        /* ignore — env file is optional */
    }
}

function parseArgs(argv) {
    const out = {
        domain: null,
        record: null,
        type: 'A',
        value: null,
        ttl: 300,
        dryRun: false,
        // Apex (@) records are gated behind two flags. --allow-apex opts in
        // to the apex code path at all; --force is *additionally* required
        // to overwrite an existing apex record. Both flags default off so a
        // typo like --record @,api-matter can never accidentally repoint
        // the bare domain to a new IP.
        allowApex: false,
        force: false
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--domain') out.domain = next();
        else if (a === '--record' || a === '--subdomain') out.record = next();
        else if (a === '--type') out.type = String(next() || 'A').toUpperCase();
        else if (a === '--value' || a === '--target') out.value = next();
        else if (a === '--ttl') out.ttl = Number(next());
        else if (a === '--dry-run') out.dryRun = true;
        else if (a === '--allow-apex') out.allowApex = true;
        else if (a === '--force') out.force = true;
        else if (a === '--help' || a === '-h') {
            printUsage();
            process.exit(0);
        }
    }
    return out;
}

function printUsage() {
    console.log(`Hostinger DNS upsert
Usage:
  node scripts/hostinger-dns.cjs \\
    --domain stellarinfomatica.com \\
    --record matter,api-matter \\
    --type A \\
    --value 203.0.113.42 \\
    [--ttl 300] [--dry-run]

  # Apex (bare-domain) records:
  node scripts/hostinger-dns.cjs \\
    --domain stellarinfomatica.com \\
    --record @ \\
    --type A \\
    --value 203.0.113.42 \\
    --allow-apex --force

Flags:
  --allow-apex   opt in to apex (@) record handling at all
  --force        required to overwrite an existing apex record (no-op
                 noops still pass without --force; create-from-empty
                 is also blocked without --force as a belt-and-braces
                 guard against accidentally repointing the whole zone)
  --dry-run      print intended action without calling the API

Environment:
  HOSTINGER_API_KEY    required — Developer API token from hostinger.com
`);
}

const API_BASE = 'https://developers.hostinger.com/api/dns/v1';

async function api(token, method, pathSuffix, body) {
    const r = await fetch(`${API_BASE}${pathSuffix}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            Accept: 'application/json'
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    let parsed = null;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        parsed = { raw: text };
    }
    if (!r.ok) {
        const err = new Error(`Hostinger ${method} ${pathSuffix} → ${r.status}: ${text}`);
        err.status = r.status;
        err.body = parsed;
        throw err;
    }
    return parsed;
}

async function listRecords(token, domain) {
    const j = await api(token, 'GET', `/zones/${encodeURIComponent(domain)}/records`);
    // Different API versions wrap the array differently; normalise.
    const rows = Array.isArray(j)
        ? j
        : Array.isArray(j?.data)
          ? j.data
          : Array.isArray(j?.records)
            ? j.records
            : [];
    return rows.map((row) => ({
        id: row.id || row.record_id || row.uuid || null,
        name: row.name || row.host || row.subdomain || '',
        type: String(row.type || '').toUpperCase(),
        value: row.value ?? row.content ?? row.data ?? '',
        ttl: row.ttl != null ? Number(row.ttl) : null,
        raw: row
    }));
}

/**
 * Hostinger represents the apex record as either '@' or the bare domain in
 * `name`. We normalise both shapes when matching so a record stored as
 * "stellarinfomatica.com" still gets recognised when the user passes "@".
 */
function isApexName(record) {
    return record === '@' || record === '';
}

function recordMatches(row, record, domain) {
    if (row.type !== undefined) {
        // case-handled separately by caller
    }
    if (isApexName(record)) {
        return row.name === '@' || row.name === '' || row.name === domain;
    }
    return row.name === record;
}

async function upsertRecord(token, domain, record, type, value, ttl, dryRun, opts = {}) {
    const apex = isApexName(record);
    const allowApex = !!opts.allowApex;
    const force = !!opts.force;

    if (apex && !allowApex) {
        const e = new Error(
            `apex (@) record requires --allow-apex (refusing to touch the bare domain by default)`
        );
        e.code = 'APEX_NOT_ALLOWED';
        throw e;
    }

    const existing = await listRecords(token, domain);
    const match = existing.find((r) => recordMatches(r, record, domain) && r.type === type);

    if (match && match.value === value && (ttl == null || match.ttl === ttl)) {
        return { action: 'noop', record: match };
    }

    // Belt-and-braces guard for apex records. We refuse without --force when:
    //  * an existing apex record's value would change (overwrite), OR
    //  * no apex record exists yet (create-from-empty — usually means the
    //    user typo'd '@' instead of a subdomain). Either way the operator
    //    has to explicitly opt in to changing the bare domain.
    if (apex && !force) {
        if (match) {
            const e = new Error(
                `apex (@) ${type} for ${domain} already points to ${JSON.stringify(match.value)}; ` +
                    `refuse to overwrite without --force`
            );
            e.code = 'APEX_OVERWRITE_REFUSED';
            e.existing = match;
            throw e;
        }
        const e = new Error(
            `no apex (@) ${type} record exists for ${domain}; refuse to create without --force`
        );
        e.code = 'APEX_CREATE_REFUSED';
        throw e;
    }

    const payload = { name: apex ? '@' : record, type, value, ttl };
    if (dryRun) {
        return { action: match ? 'update (dry-run)' : 'create (dry-run)', record: match || payload, payload };
    }
    if (match) {
        const updated = await api(
            token,
            'PUT',
            `/zones/${encodeURIComponent(domain)}/records/${encodeURIComponent(match.id)}`,
            payload
        );
        return { action: 'update', record: updated };
    }
    const created = await api(token, 'POST', `/zones/${encodeURIComponent(domain)}/records`, payload);
    return { action: 'create', record: created };
}

async function main() {
    loadEnv();
    const args = parseArgs(process.argv.slice(2));

    if (!args.domain || !args.record || !args.value) {
        printUsage();
        console.error('Error: --domain, --record, and --value are required.');
        process.exit(2);
    }

    const token = process.env.HOSTINGER_API_KEY;
    if (!token) {
        console.error('Error: HOSTINGER_API_KEY is not set (paste it into .env).');
        process.exit(2);
    }

    const records = String(args.record)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    const hasApex = records.some((r) => r === '@' || r === '');
    if (hasApex && args.allowApex) {
        // Loud-on-purpose banner so the operator notices what they're about
        // to do — apex changes can take an entire domain offline.
        const guard = args.force ? '--force' : 'NOT --force (no-op + dry-run only)';
        console.warn(
            `[warn] apex (@) record handling enabled for ${args.domain} ` +
                `(allow-apex, ${guard}). This affects the bare domain.`
        );
    }

    for (const rec of records) {
        try {
            const r = await upsertRecord(
                token,
                args.domain,
                rec,
                args.type,
                args.value,
                args.ttl,
                args.dryRun,
                { allowApex: args.allowApex, force: args.force }
            );
            const label = rec === '@' ? args.domain : `${rec}.${args.domain}`;
            console.log(`[${r.action}] ${label} ${args.type} -> ${args.value} (ttl ${args.ttl})`);
        } catch (err) {
            const label = rec === '@' ? args.domain : `${rec}.${args.domain}`;
            console.error(`[error] ${label}: ${err.message || err}`);
            process.exitCode = 1;
        }
    }
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
