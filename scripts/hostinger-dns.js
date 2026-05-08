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
 *   node scripts/hostinger-dns.js \
 *     --domain stellarinfomatica.com \
 *     --record matter,api-matter \
 *     --type A \
 *     --value 203.0.113.42
 *
 *   node scripts/hostinger-dns.js \
 *     --domain stellarinfomatica.com \
 *     --record api-matter \
 *     --type CNAME \
 *     --value matter.stellarinfomatica.com.
 *
 * Phase 12 (out of scope here) extends this with --allow-apex / --force.
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
    const out = { domain: null, record: null, type: 'A', value: null, ttl: 300, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        const next = () => argv[++i];
        if (a === '--domain') out.domain = next();
        else if (a === '--record' || a === '--subdomain') out.record = next();
        else if (a === '--type') out.type = String(next() || 'A').toUpperCase();
        else if (a === '--value' || a === '--target') out.value = next();
        else if (a === '--ttl') out.ttl = Number(next());
        else if (a === '--dry-run') out.dryRun = true;
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
  node scripts/hostinger-dns.js \\
    --domain stellarinfomatica.com \\
    --record matter,api-matter \\
    --type A \\
    --value 203.0.113.42 \\
    [--ttl 300] [--dry-run]

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

async function upsertRecord(token, domain, record, type, value, ttl, dryRun) {
    const existing = await listRecords(token, domain);
    const match = existing.find((r) => r.name === record && r.type === type);
    if (match && match.value === value && (ttl == null || match.ttl === ttl)) {
        return { action: 'noop', record: match };
    }
    const payload = { name: record, type, value, ttl };
    if (dryRun) {
        return { action: match ? 'update (dry-run)' : 'create (dry-run)', record: match || payload, payload };
    }
    if (match) {
        const updated = await api(token, 'PUT', `/zones/${encodeURIComponent(domain)}/records/${encodeURIComponent(match.id)}`, payload);
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

    if (records.includes('@')) {
        console.error('Error: apex (@) record support requires --allow-apex --force (Phase 12, not enabled here).');
        process.exit(2);
    }

    for (const rec of records) {
        try {
            const r = await upsertRecord(token, args.domain, rec, args.type, args.value, args.ttl, args.dryRun);
            console.log(
                `[${r.action}] ${rec}.${args.domain} ${args.type} -> ${args.value} (ttl ${args.ttl})`
            );
        } catch (err) {
            console.error(`[error] ${rec}.${args.domain}: ${err.message || err}`);
            process.exitCode = 1;
        }
    }
}

main().catch((e) => {
    console.error('Fatal:', e);
    process.exit(1);
});
