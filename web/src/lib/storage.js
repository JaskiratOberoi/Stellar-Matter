// localStorage keys + safe helpers. Names mirror the legacy app.js
// (lisbot:* prefix) so existing user state survives the React port.

export const LS_VIEW = 'lisbot:view';
export const LS_SIDEBAR = 'lisbot:sidebar';
export const LS_SOURCE = 'lisbot:source';
export const LS_HIDDEN = 'lisbot:hidden-tiles';
export const LS_BU_SELECTION = 'lisbot:bu-selection';

export function readJSON(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function writeJSON(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        /* ignore quota / disabled storage */
    }
}

export function readString(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : raw;
    } catch {
        return fallback;
    }
}

export function writeString(key, value) {
    try {
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        /**/
    }
}

export function readHiddenSet() {
    const arr = readJSON(LS_HIDDEN, []);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
}

export function writeHiddenSet(set) {
    writeJSON(LS_HIDDEN, [...set]);
}

export function clearHiddenSet() {
    writeString(LS_HIDDEN, null);
}
