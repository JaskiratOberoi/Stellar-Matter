/**
 * Banner key and label for a Client codes pick. Mirrors
 * resolveTracerClientCodes() in scripts/lis-nav-bot/server.js — the server
 * tags the run's tiles with this key, and the wall finds them by it.
 *
 * @param {string[]} picked master client codes as selected
 * @returns {{ key: string, label: string } | null}
 */
export function clientCodeScope(picked) {
    const codes = [...new Set((picked || []).map((c) => String(c || '').trim().toUpperCase()).filter(Boolean))]
        .sort()
        .slice(0, 500);
    if (!codes.length) return null;
    let h = 5381;
    for (const ch of codes.join(',')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
    const bare = [...new Set(codes.map((c) => c.split(/\s+/)[0]))];
    const shown = bare.slice(0, 3).join(', ');
    return {
        key: `codes-${h.toString(36)}`,
        label: `Client codes · ${shown}${bare.length > 3 ? ` +${bare.length - 3}` : ''}`
    };
}
