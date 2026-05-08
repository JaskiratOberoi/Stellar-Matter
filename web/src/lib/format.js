// Pure formatting + label helpers ported from scripts/lis-nav-bot/public/app.js.

export function pad2(n) {
    return String(n).padStart(2, '0');
}

export function fmtDDMMYYYY(d) {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export function offsetDays(n) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + n);
    return d;
}

export function todayRange() {
    const d = offsetDays(0);
    return { from: d, to: d };
}

export function singleDay(n) {
    const d = offsetDays(n);
    return { from: d, to: d };
}

export function lastNDays(n) {
    return { from: offsetDays(-n), to: offsetDays(0) };
}

export function monthRange(monthOffset) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0);
    start.setHours(0, 0, 0, 0);
    end.setHours(0, 0, 0, 0);
    return { from: start, to: end };
}

export const QUICK_RANGES = [
    { id: 'today', label: 'TODAY', build: todayRange },
    { id: 'yest', label: 'YESTERDAY', build: () => singleDay(-1) },
    { id: 'last7', label: '\u22127D', build: () => lastNDays(6) },
    { id: 'thisMonth', label: 'THIS MONTH', build: () => monthRange(0) },
    { id: 'lastMonth', label: 'LAST MONTH', build: () => monthRange(-1) }
];

export function fmtDateRange(fromDate, toDate) {
    const from = (fromDate || '').trim();
    const to = (toDate || '').trim();
    if (!from && !to) return 'No date window';
    if (from && to && from === to) return from;
    if (from && to) return `${from} \u2192 ${to}`;
    return from || to;
}

export function normalizePackageLabel(s) {
    return String(s || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();
}

export function tileEyebrow(tile, indexFromOne) {
    const idx = String(indexFromOne).padStart(2, '0');
    const src = String(tile.source || 'scrape').toUpperCase();
    let timeStr = '';
    if (tile.startedAt) {
        const d = new Date(tile.startedAt);
        if (!Number.isNaN(d.getTime())) {
            timeStr = d.toLocaleString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                day: '2-digit',
                month: 'short'
            });
        }
    }
    const parts = [`${idx} / RUN`, src];
    if (timeStr) parts.push(timeStr);
    return parts.join(' \u00b7 ');
}
