// Lifted from Stellar-Shark; renamed token key + base env var for Stellar Matter.
const TOKEN_KEY = 'stellar_matter_token';

/**
 * In Vite dev (`npm run dev`), always use relative `/api/*` so the dev-server proxy
 * (vite.config.js → Matter on LIS_UI_PORT / 4377) is used. Otherwise a stray
 * VITE_API_BASE_URL in .env.local can point at production, which may not ship newer
 * routes (JSON 404/HTML) while `/api/bu` still works — a confusing split.
 *
 * Production and `vite preview` of a production build still use VITE_API_BASE_URL
 * from web/.env.production (see web/package.json build).
 */
const API_BASE = import.meta.env.DEV
    ? ''
    : (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

export function apiUrl(path) {
    if (!path) return API_BASE;
    if (/^https?:\/\//i.test(path)) return path;
    const suffix = path.startsWith('/') ? path : `/${path}`;
    return `${API_BASE}${suffix}`;
}

export function getToken() {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
    if (typeof localStorage === 'undefined') return;
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
}

export function authHeaders() {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
}

// Connection and session signals for the app shell (see SessionGuard). Every
// request goes through apiFetch, so this is the one place that can tell "the
// server said your token is no good" apart from "the server is unreachable".
export const SESSION_EXPIRED_EVENT = 'matter:session-expired';
export const NETWORK_EVENT = 'matter:network';

let networkDown = false;

function setNetworkDown(down) {
    if (networkDown === down) return;
    networkDown = down;
    window.dispatchEvent(new CustomEvent(NETWORK_EVENT, { detail: { offline: down } }));
}

export function isNetworkDown() {
    return networkDown;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
export async function apiFetch(path, init = {}) {
    const headers = new Headers(init.headers || {});
    const t = getToken();
    if (t) headers.set('Authorization', `Bearer ${t}`);
    if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
    }
    let res;
    try {
        res = await fetch(apiUrl(path), { ...init, headers });
    } catch (e) {
        if (!(e && e.name === 'AbortError')) setNetworkDown(true);
        throw e;
    }
    setNetworkDown(false);
    // A 401 on a request that carried a token means the session ended (expired
    // or revoked). Auth endpoints report their own failures.
    if (res.status === 401 && t && !String(path).startsWith('/api/auth/')) {
        window.dispatchEvent(new CustomEvent(SESSION_EXPIRED_EVENT));
    }
    return res;
}
