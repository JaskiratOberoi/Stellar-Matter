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
    return fetch(apiUrl(path), { ...init, headers });
}
