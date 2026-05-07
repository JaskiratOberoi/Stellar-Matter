'use strict';

const { delay } = require('./dom');

async function clickSearch(page) {
    const clickedViaDom = await page.evaluate(() => {
        const el =
            document.querySelector("input[id*='btnSearch']") ||
            document.querySelector("input[type='submit'][value*='Search']") ||
            Array.from(document.querySelectorAll('button')).find((b) => /search/i.test(String(b.textContent || '')));
        if (!el) return false;
        if (typeof el.click === 'function') el.click();
        return true;
    });
    if (clickedViaDom) {
        await delay(700);
        return true;
    }
    return false;
}

async function waitForSampleGrid(page, timeoutMs = 15000) {
    try {
        await page.waitForSelector('table[id*="gvSample"]', { timeout: timeoutMs });
    } catch (_) {}
    await delay(400);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {{ skipRegionalBadge?: boolean }} [opts]
 */
async function listSidsForCurrentPage(page, opts = {}) {
    const skipRegional = !!opts.skipRegionalBadge;
    const sids = await page.evaluate((skipBadges) => {
        const rows = Array.from(document.querySelectorAll("table[id*='gvSample'] tbody tr"));
        const unique = new Set();
        const out = [];
        const badValues = new Set(['save', 'desc', 'x', 'result', 'export']);
        const sidRegex = /^[A-Za-z0-9-]{5,}$/;
        for (const row of rows) {
            const table = row.closest('table');
            const tableId = String((table && table.id) || '').toLowerCase();
            if (!tableId.includes('gvsample')) continue;
            if (skipBadges) {
                const regionBadge = row.querySelector(
                    "span[id*='lblmccCode'] span.badge, span[id*='lblmccCode'] span[class*='badge']"
                );
                if (regionBadge) continue;
            }
            const sidLink = row.querySelector("a[id*='hpVail'], td:nth-child(4) a");
            if (!sidLink) continue;
            const sid = String(sidLink.textContent || sidLink.innerText || '').trim();
            const sidLower = sid.toLowerCase();
            if (!sidRegex.test(sid) || badValues.has(sidLower)) continue;
            if (!sid || unique.has(sid)) continue;
            unique.add(sid);
            out.push(sid);
        }
        return out;
    }, skipRegional);
    return sids;
}

/**
 * @param {import('puppeteer').Page} page
 */
async function getSampleGridPagerInfo(page) {
    return page.evaluate(() => {
        const grid = document.querySelector('table[id*="gvSample"]');
        const pgrRow = grid
            ? grid.querySelector('tr.pgr, tr[class*="pgr"]')
            : document.querySelector('tr.pgr, tr[class*="pgr"]');
        if (!pgrRow) return { found: false };
        const nestedTable = pgrRow.querySelector('table');
        const tds = nestedTable
            ? Array.from(nestedTable.querySelectorAll('td'))
            : Array.from(pgrRow.querySelectorAll('td'));
        const elements = [];
        for (const td of tds) {
            const children = td.querySelectorAll('a, span');
            if (children.length) elements.push(...Array.from(children));
            else {
                const text = (td.textContent || '').trim();
                const n = parseInt(text, 10);
                if (!Number.isNaN(n) && n >= 1) elements.push(td);
            }
        }
        let currentPageNum = null;
        for (const el of elements) {
            const text = (el.textContent || '').trim();
            const n = parseInt(text, 10);
            if (Number.isNaN(n) || n < 1) continue;
            const isSpan = el.tagName === 'SPAN';
            const isActive =
                isSpan ||
                el.classList.contains('active') ||
                window.getComputedStyle(el).fontWeight === 'bold' ||
                (el.closest('td') && el.closest('td').classList.toString().includes('selected'));
            if (isActive && currentPageNum === null) currentPageNum = n;
        }
        const allPages = [
            ...new Set(
                elements
                    .map((el) => parseInt((el.textContent || '').trim(), 10))
                    .filter((n) => !Number.isNaN(n) && n >= 1)
            )
        ].sort((a, b) => a - b);
        return {
            found: true,
            currentPage: currentPageNum,
            allPages,
            rowText: (pgrRow.textContent || '').trim().slice(0, 200)
        };
    });
}

module.exports = {
    clickSearch,
    waitForSampleGrid,
    listSidsForCurrentPage,
    getSampleGridPagerInfo
};
