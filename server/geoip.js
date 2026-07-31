'use strict';

// IP -> approximate location for the audit trail.
//
// Two hard rules, both because this sits behind every audited action:
//   1. Never throw. A failed lookup returns null and the audit row simply has
//      no geo.
//   2. Never block the request path. Callers resolve geo *after* the audit row
//      is written (see server/audit.js) and patch it in.
//
// Lookups go to a public geolocation API, so private/loopback addresses are
// short-circuited locally — both to avoid a pointless round trip and to keep
// LAN-only deployments from leaking anything outward. Set GEOIP_ENABLED=0 to
// disable outbound lookups entirely; the trail still records IPs.

const DEFAULT_PROVIDER_URL =
    'http://ip-api.com/json/{ip}?fields=status,message,country,countryCode,regionName,city,zip,lat,lon,timezone,isp,org,as,proxy,hosting';

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Failures are usually transient (the free tier rate-limits at ~45 req/min), so
// they expire quickly instead of marking an address unresolvable for a day.
const CACHE_FAILURE_TTL_MS = 5 * 60 * 1000;
const CACHE_MAX_ENTRIES = 2000;
const LOOKUP_TIMEOUT_MS = 2500;

const cache = new Map();

function enabled() {
    const v = process.env.GEOIP_ENABLED;
    if (v == null || String(v).trim() === '') return true;
    return !['0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase());
}

function providerUrl(ip) {
    const tpl = process.env.GEOIP_PROVIDER_URL && String(process.env.GEOIP_PROVIDER_URL).trim()
        ? String(process.env.GEOIP_PROVIDER_URL).trim()
        : DEFAULT_PROVIDER_URL;
    return tpl.replace('{ip}', encodeURIComponent(ip));
}

// Express hands us IPv4-mapped IPv6 ("::ffff:10.0.0.4") behind a proxy, and
// x-forwarded-for can carry a port. Both break provider lookups and make the
// same client look like two different ones in the trail.
function normalizeIp(raw) {
    if (raw == null) return null;
    let ip = String(raw).trim();
    if (!ip) return null;
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') ip = '127.0.0.1';
    // "1.2.3.4:5678" — strip the port, but leave bare IPv6 (many colons) alone.
    const colons = ip.split(':').length - 1;
    if (colons === 1 && ip.includes('.')) ip = ip.split(':')[0];
    return ip || null;
}

function isPrivateIp(ip) {
    if (!ip) return true;
    if (ip === '127.0.0.1' || ip === 'localhost') return true;
    if (ip.includes(':')) {
        // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
        const low = ip.toLowerCase();
        return low === '::1' || low.startsWith('fc') || low.startsWith('fd') || low.startsWith('fe8');
    }
    const parts = ip.split('.').map((n) => Number(n));
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    return false;
}

// Human-readable one-liner the UI can show without re-deriving it per row.
function buildLabel(parts) {
    const bits = [parts.city, parts.region, parts.country].filter(Boolean);
    return bits.length ? bits.join(', ') : null;
}

function cacheGet(ip) {
    const hit = cache.get(ip);
    if (!hit) return undefined;
    const ttl = hit.value ? CACHE_TTL_MS : CACHE_FAILURE_TTL_MS;
    if (Date.now() - hit.at > ttl) {
        cache.delete(ip);
        return undefined;
    }
    return hit.value;
}

function cacheSet(ip, value) {
    if (cache.size >= CACHE_MAX_ENTRIES) {
        // Cheap FIFO eviction — insertion order is good enough here.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(ip, { at: Date.now(), value });
}

async function fetchGeo(ip) {
    if (typeof fetch !== 'function') return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const res = await fetch(providerUrl(ip), { signal: controller.signal });
        if (!res.ok) return null;
        const j = await res.json();
        if (j && j.status && j.status !== 'success') return null;
        const parts = {
            scope: 'public',
            city: j.city || null,
            region: j.regionName || j.region || null,
            country: j.country || null,
            country_code: j.countryCode || null,
            postal: j.zip || j.postal || null,
            latitude: j.lat != null ? j.lat : null,
            longitude: j.lon != null ? j.lon : null,
            timezone: j.timezone || null,
            isp: j.isp || j.org || null,
            network: j.as || null,
            proxy: j.proxy === true || undefined,
            hosting: j.hosting === true || undefined
        };
        parts.label = buildLabel(parts);
        return parts;
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// Resolve an IP to a geo object, or null when it cannot be determined.
// Private addresses resolve locally to a { scope: 'private' } marker so the UI
// can say "Internal network" instead of showing an empty cell.
async function lookupGeo(rawIp) {
    const ip = normalizeIp(rawIp);
    if (!ip) return null;
    if (isPrivateIp(ip)) {
        return { scope: 'private', label: 'Internal network' };
    }
    if (!enabled()) return null;

    const cached = cacheGet(ip);
    if (cached !== undefined) return cached;

    const value = await fetchGeo(ip);
    cacheSet(ip, value);
    return value;
}

module.exports = { lookupGeo, normalizeIp, isPrivateIp };
