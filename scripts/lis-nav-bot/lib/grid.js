'use strict';

const { delay, toPuppeteerXPath } = require('./dom');

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

/**
 * @param {import('puppeteer').Page} page
 * @param {{ skipRegionalBadge?: boolean }} [opts]
 * @returns {Promise<{ sid: string, testNamesText: string }[]>}
 */
async function scrapeSampleRowsWithTestNames(page, opts = {}) {
    const skipRegional = !!opts.skipRegionalBadge;
    return page.evaluate((skipBadges) => {
        const rows = Array.from(document.querySelectorAll("table[id*='gvSample'] tbody tr"));
        const badValues = new Set(['save', 'desc', 'x', 'result', 'export']);
        const sidRegex = /^[A-Za-z0-9-]{5,}$/;
        /** @type {{ sid: string, testNamesText: string }[]} */
        const out = [];
        let lastSeenSid = '';

        const testCellFromRow = (row) => {
            const spanNames = row.querySelector("span[id*='lblTestnames'], span[id*='lblTestname']");
            if (spanNames) return spanNames;
            const td5 = row.querySelector('td:nth-child(5)');
            return td5;
        };

        for (const row of rows) {
            if (row.classList.contains('pgr')) continue;
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
            let sid = '';

            if (sidLink) {
                const cand = String(sidLink.textContent || sidLink.innerText || '').trim();
                const sidLower = cand.toLowerCase();
                if (sidRegex.test(cand) && !badValues.has(sidLower)) {
                    sid = cand;
                    lastSeenSid = cand;
                }
            }

            const testEl = testCellFromRow(row);
            const testNamesText = testEl ? String(testEl.innerText || testEl.textContent || '').trim() : '';

            if (sid) {
                out.push({ sid, testNamesText });
            } else if (testNamesText && testNamesText.indexOf('[') !== -1) {
                /** Continuation row: inherits SID from preceding primary row */
                out.push({ sid: lastSeenSid, testNamesText });
            }
        }
        return out;
    }, skipRegional);
}

/**
 * After a pager click, wait until first SID or current page index changes.
 * @param {import('puppeteer').Page} page
 * @param {string | null} prevFirstSid
 * @param {number | null} prevPagerPage
 * @param {number} timeoutMs
 * @param {{ skipRegionalBadge?: boolean }} [listOpts]
 */
async function waitForSampleGridPageTurn(page, prevFirstSid, prevPagerPage, timeoutMs = 12000, listOpts = {}) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        await delay(200);
        const sids = await listSidsForCurrentPage(page, listOpts);
        const first = sids.length ? sids[0] : null;
        if (prevFirstSid != null && first != null && first !== prevFirstSid) return true;
        if (prevFirstSid == null && first != null) return true;
        const info = await getSampleGridPagerInfo(page);
        if (info && info.found && prevPagerPage != null && info.currentPage != null && info.currentPage !== prevPagerPage) {
            return true;
        }
    }
    return false;
}

/**
 * Port of cbc_reader_bot.navigateToNextSampleGridPage — click next pager control.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<boolean>}
 */
async function tryClickNextSampleGridPage(page) {
    const info = await getSampleGridPagerInfo(page);
    if (!info.found) return false;
    const currentPage = info.currentPage ?? 1;
    const availablePages = info.allPages || [];
    const nextNum = availablePages.find((p) => p > currentPage);

    if (nextNum != null) {
        const clicked = await page.evaluate((targetPage) => {
            const grid = document.querySelector('table[id*="gvSample"]');
            const pgrRow = grid
                ? grid.querySelector('tr.pgr, tr[class*="pgr"]')
                : document.querySelector('tr.pgr, tr[class*="pgr"]');
            if (!pgrRow) return false;
            const links = Array.from(pgrRow.querySelectorAll('a'));
            const link = links.find((a) => (a.textContent || '').trim() === String(targetPage));
            if (!link) return false;
            if (link.classList.contains('aspNetDisabled')) return false;
            link.click();
            return true;
        }, nextNum);
        if (clicked) return true;
    }

    const nextViaDom = await page.evaluate(() => {
        const grid = document.querySelector('table[id*="gvSample"]');
        const pgrRow = grid
            ? grid.querySelector('tr.pgr, tr[class*="pgr"]')
            : document.querySelector('tr.pgr, tr[class*="pgr"]');
        const scope = pgrRow || grid || document;

        const tryClick = (el) => {
            if (!el || el.disabled) return false;
            const cls = String(el.className || '');
            if (cls.includes('aspNetDisabled') || cls.includes('disabled')) return false;
            el.removeAttribute('disabled');
            if (typeof el.click === 'function') el.click();
            return true;
        };

        const anchors = Array.from(scope.querySelectorAll('a'));
        for (const a of anchors) {
            const t = (a.textContent || '').trim();
            const oc = String(a.getAttribute('onclick') || '');
            const href = String(a.getAttribute('href') || '');
            if (/Page\$Next/i.test(oc) || /Page\$Next/i.test(href)) {
                if (tryClick(a)) return true;
            }
            if (t === 'Next' || t === '>' || t === '»') {
                if (tryClick(a)) return true;
            }
        }

        const byId = document.querySelector("a[id*='lnkNext']") || document.querySelector("a[id*='LinkButton'][id*='Next']");
        if (byId && tryClick(byId)) return true;

        return false;
    });
    if (nextViaDom) return true;

    /** ASP.NET gvSample ellipsis / jump links use __doPostBack(..., 'Page$N'); click smallest N > currentPage. */
    const pageJump = await page.evaluate((curr) => {
        const currPage =
            curr == null || curr === '' || Number.isNaN(Number(curr))
                ? 1
                : Math.max(1, Math.floor(Number(curr)));
        const grid = document.querySelector('table[id*="gvSample"]');
        const pgrRow = grid
            ? grid.querySelector('tr.pgr, tr[class*="pgr"]')
            : document.querySelector('tr.pgr, tr[class*="pgr"]');
        if (!pgrRow) return false;

        /**
         * @param {string} s
         * @returns {number[]}
         */
        const pageNumsFromStr = (s) => {
            const out = [];
            const re = /Page\$(\d+)/gi;
            let m;
            while ((m = re.exec(s)) !== null) {
                const n = Number(m[1]);
                if (Number.isFinite(n) && n >= 1) out.push(n);
            }
            return out;
        };

        const tryClickEl = (el) => {
            if (!el) return false;
            if (el.classList.contains('aspNetDisabled') || String(el.className || '').includes('disabled')) return false;
            if (typeof el.click === 'function') el.click();
            return true;
        };

        const anchors = Array.from(pgrRow.querySelectorAll('a'));

        /** @type {{ n: number, el: HTMLElement }[]} */
        const targets = [];

        for (const a of anchors) {
            const t = String(a.textContent || '')
                .normalize('NFKC')
                .trim()
                .replace(/\s+/g, ' ');
            const oc = String(a.getAttribute('onclick') || '');
            const href = String(a.getAttribute('href') || '');
            const merged = oc + '\n' + href;
            let best = Infinity;

            const numsFromAttr = [...new Set(pageNumsFromStr(merged))];
            for (const num of numsFromAttr) {
                if (num > currPage && num < best) best = num;
            }

            const isEllipsisJump =
                t === '...' ||
                t === '\u2026' ||
                /^\.{2,}$/.test(t.replace(/\u200b|\u2060/g, '')) ||
                t === '>>' ||
                t === '\u00bb\u00bb' ||
                t === '&gt;&gt;' ||
                /\u00bb\s*\u00bb/.test(t);

            const numsVisible = [...new Set(pageNumsFromStr(t))];
            for (const num of numsVisible) {
                if (num > currPage && num < best) best = num;
            }

            const nextFromAttrs = numsFromAttr.filter((n) => n > currPage);

            let clickN = best;
            if (clickN === Infinity && isEllipsisJump && nextFromAttrs.length) {
                clickN = Math.min(...nextFromAttrs);
            }

            if (clickN !== Infinity) targets.push({ n: clickN, el: a });
        }

        targets.sort((x, y) => x.n - y.n || 0);
        const pick = targets[0];
        return pick ? tryClickEl(pick.el) : false;
    }, currentPage);
    if (pageJump) return true;

    try {
        const handles = await page.$$(
            toPuppeteerXPath(
                "//table[contains(@id,'gvSample')]//tr[contains(@class,'pgr')]//a[" +
                    "contains(translate(normalize-space(text()), 'NEXT', 'next'), 'next') or " +
                    "contains(@onclick, 'Page$Next') or contains(@href, 'Page$Next')]"
            )
        );
        if (handles && handles.length > 0) {
            const el = handles[0];
            for (let i = 1; i < handles.length; i++) {
                if (typeof handles[i].dispose === 'function') handles[i].dispose();
            }
            const disabled = await page.evaluate(
                (node) =>
                    !node || node.classList.contains('aspNetDisabled') || node.classList.contains('disabled'),
                el
            );
            if (!disabled) {
                await page.evaluate((node) => node.scrollIntoView({ block: 'center' }), el);
                await delay(80);
                await el.click();
                if (typeof el.dispose === 'function') await el.dispose();
                return true;
            }
            if (typeof el.dispose === 'function') await el.dispose();
        }
    } catch (_) {}

    return false;
}

/**
 * Detect whether worksheet session + grid UI look intact (cheap main-thread read).
 * @param {import('puppeteer').Page} page
 * @param {{ expectedBuSelectValue?: string|null }} [canary]
 * @returns {Promise<{ ok: boolean, reason: string }>}
 */
async function verifyWorksheetSession(page, canary = {}) {
    const expBu = canary.expectedBuSelectValue != null ? String(canary.expectedBuSelectValue) : null;
    return page.evaluate((exp) => {
        const hrefFull = String(window.location.href || '').toLowerCase();
        if (/\/login\.aspx\b/i.test(hrefFull)) return { ok: false, reason: 'login_redirect' };
        const pathBlob = `${String(location.pathname)}${String(location.search)}`.toLowerCase();
        if (!pathBlob.includes('sampleworksheet'))
            return { ok: false, reason: 'navigated_off' };

        const grid = document.querySelector('table[id*="gvSample"]');
        if (!grid) return { ok: false, reason: 'no_grid' };

        if (exp != null && exp !== '') {
            const sel =
                document.querySelector('select[id*="ddlBunit"], select[name*="ddlBunit"]') ||
                document.querySelector('select[id*="BusinessUnit"], select[name*="BusinessUnit"]');
            if (!sel) return { ok: false, reason: 'bu_select_missing' };
            if (String(sel.value || '') !== exp)
                return { ok: false, reason: `bu_changed (was="${String(sel.value)}", expect="${exp}")` };
        }
        return { ok: true, reason: 'ok' };
    }, expBu);
}

/**
 * Jump pager to a specific ASP.NET GridView Page$N via __doPostBack or visible pager anchor.
 * @param {import('puppeteer').Page} page
 * @param {number} targetPage
 * @param {{ skipRegionalBadge?: boolean }} [opts]
 * @returns {Promise<boolean>}
 */
async function jumpToSampleGridPage(page, targetPage, opts = {}) {
    const tgt = Math.max(1, Math.floor(Number(targetPage)));

    try {
        const info0 = await getSampleGridPagerInfo(page);
        if (!info0.found) return false;
        if ((info0.currentPage ?? 1) === tgt) return true;

        const sidsBefore = await listSidsForCurrentPage(page, opts);
        const prevFirstSid = sidsBefore.length ? sidsBefore[0] : null;
        const prevPagerPage = info0.currentPage ?? null;

        const invoked = await page.evaluate((wanted) => {
            const grid = document.querySelector('table[id*="gvSample"]');
            const pgrRow = grid
                ? grid.querySelector('tr.pgr, tr[class*="pgr"]')
                : document.querySelector('tr.pgr, tr[class*="pgr"]');
            if (!pgrRow) return false;

            const anchors = Array.from(pgrRow.querySelectorAll('a'));
            const wantStr = String(wanted);

            /** text link "48" */
            for (const a of anchors) {
                const txt = String(a.textContent || '')
                    .replace(/\u200b|\u2060/g, '')
                    .trim();
                if (txt === wantStr && !a.classList.contains('aspNetDisabled')) {
                    a.click();
                    return true;
                }
            }

            /** click link whose onclick/href posts exactly Page$N */
            const pageRe = new RegExp(`Page\\\\$${wanted}(?!\\\\d)`);
            for (const a of anchors) {
                const merged = `${String(a.getAttribute('onclick') || '')}\n${String(a.getAttribute('href') || '')}`;
                if (pageRe.test(merged) && !a.classList.contains('aspNetDisabled')) {
                    a.click();
                    return true;
                }
            }

            /** fall back: __doPostBack(eventTarget, 'Page$N') using first Page$… pair in pager HTML */
            const html = String(pgrRow.innerHTML || '');
            let eventTarget = '';
            let m = html.match(/__doPostBack\s*\(\s*'([^']+)'\s*,\s*'Page\$\d+'/i);
            if (!m) m = html.match(/__doPostBack\s*\(\s*"([^"]+)"\s*,\s*"Page\$\d+"/i);
            if (m) eventTarget = m[1];

            if (eventTarget && typeof window.__doPostBack === 'function') {
                window.__doPostBack(eventTarget, `Page$${wanted}`);
                return true;
            }

            return false;
        }, tgt);

        if (!invoked) return false;

        await waitForSampleGridPageTurn(page, prevFirstSid, prevPagerPage, 20000, opts);
        await delay(450);
        const info1 = await getSampleGridPagerInfo(page);
        if (!info1.found || info1.currentPage == null) return false;
        /** loose pass: pager UI may redraw with a shifted window near the desired index */
        if (Number(info1.currentPage) !== tgt && Math.abs(Number(info1.currentPage) - tgt) > 2) return false;
        await delay(200);
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Click next page + wait for grid to update.
 * @param {import('puppeteer').Page} page
 * @param {{ skipRegionalBadge?: boolean }} [opts]
 */
async function goToNextSampleGridPage(page, opts = {}) {
    const prevInfo = await getSampleGridPagerInfo(page);
    const prevPagerPage = prevInfo.found ? prevInfo.currentPage ?? null : null;
    const sidsBefore = await listSidsForCurrentPage(page, opts);
    const prevFirstSid = sidsBefore.length ? sidsBefore[0] : null;

    const clicked = await tryClickNextSampleGridPage(page);
    if (!clicked) {
        return { moved: false, newPagerInfo: prevInfo };
    }

    await waitForSampleGridPageTurn(page, prevFirstSid, prevPagerPage, 12000, opts);
    await delay(400);
    const newPagerInfo = await getSampleGridPagerInfo(page);
    return { moved: true, newPagerInfo };
}

module.exports = {
    clickSearch,
    waitForSampleGrid,
    listSidsForCurrentPage,
    getSampleGridPagerInfo,
    scrapeSampleRowsWithTestNames,
    tryClickNextSampleGridPage,
    waitForSampleGridPageTurn,
    verifyWorksheetSession,
    jumpToSampleGridPage,
    goToNextSampleGridPage
};
