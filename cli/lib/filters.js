'use strict';

const { delay, clickElement, escapeXPathText } = require('./dom');

/**
 * Set native select + Select2 (same pattern as lis_worksheet_speed.js).
 * @param {import('puppeteer').Page} page
 * @param {string} label - option text (exact match case-insensitive)
 */
async function setStatusByLabel(page, label) {
    if (!label || !String(label).trim()) {
        console.log('[filters] status: skipped (no value)');
        return false;
    }
    const ok = await page.evaluate((lbl) => {
        const select = document.querySelector("select[id*='ddlStatus'], select[name*='ddlStatus']");
        if (!select) return false;
        const opts = Array.from(select.options || []);
        const target = opts.find((o) => (o.text || '').trim().toLowerCase() === String(lbl || '').trim().toLowerCase());
        if (!target) return false;
        select.value = target.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery && window.jQuery(select).data('select2')) {
            window.jQuery(select).val(target.value).trigger('change');
        }
        return true;
    }, label);
    if (ok) await delay(180);
    return ok;
}

/** Selectors for the ASP.NET BU `<select>`. */
const BU_SELECT_SELECTOR =
    'select[id*="ddlBunit"], select[name*="ddlBunit"], select[id*="BusinessUnit"], select[name*="BusinessUnit"]';

/**
 * Find the matching `<option>` and return its `{ value, text }` (or `null`).
 * @param {import('puppeteer').Page} page
 * @param {string} bu
 */
async function findBuOption(page, bu) {
    return page.evaluate(
        (sel, raw) => {
            const select = document.querySelector(sel);
            if (!select) return null;
            const wanted = String(raw || '').trim().toLowerCase();
            if (!wanted) return null;
            const options = Array.from(select.options || []);
            const exact = options.find(
                (o) => String(o.text || '').trim().toLowerCase() === wanted
            );
            const byValue = !exact && /^\d+$/.test(wanted)
                ? options.find((o) => String(o.value || '').trim() === wanted)
                : null;
            const byContains = !exact && !byValue
                ? options.find((o) => String(o.text || '').trim().toLowerCase().includes(wanted))
                : null;
            const opt = exact || byValue || byContains;
            if (!opt) return null;
            return { value: String(opt.value), text: String(opt.text || '').trim() };
        },
        BU_SELECT_SELECTOR,
        bu
    );
}

/**
 * Read what the BU control currently reports — both the underlying select value
 * and the visible Select2 rendered text.
 * @param {import('puppeteer').Page} page
 */
async function readBuState(page) {
    return page.evaluate((sel) => {
        const select = document.querySelector(sel);
        if (!select) return { exists: false };
        const opt = select.options[select.selectedIndex] || null;
        const rendered = document.querySelector(
            ".select2-selection__rendered[title*='Business Unit'], #select2-" +
                (select.id || '') +
                '-container'
        );
        return {
            exists: true,
            value: String(select.value || ''),
            text: opt ? String(opt.text || '').trim() : '',
            rendered: rendered ? String(rendered.textContent || '').trim() : ''
        };
    }, BU_SELECT_SELECTOR);
}

/**
 * Set Business Unit reliably:
 *   1) native value+change on the underlying select (fires Select2 listeners via jQuery)
 *   2) verify by reading select.value back; if not applied, open Select2 dropdown and click the option
 *   3) verify again and return the actual selected option text (or `null`)
 * @param {import('puppeteer').Page} page
 * @param {string} businessUnit - visible option text (e.g. "ROHTAK")
 * @returns {Promise<string|null>}
 */
async function setBusinessUnitByLabel(page, businessUnit) {
    if (!businessUnit || !String(businessUnit).trim()) {
        console.log('[filters] business unit: skipped (no value)');
        return null;
    }
    const bu = String(businessUnit).trim();

    const target = await findBuOption(page, bu);
    if (!target) {
        console.log(`[filters] business unit: no matching option for "${bu}"`);
        return null;
    }

    await page.evaluate(
        (sel, value) => {
            const select = document.querySelector(sel);
            if (!select) return;
            select.value = value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery) {
                const $sel = window.jQuery(select);
                if ($sel.data('select2')) {
                    $sel.val(value).trigger('change.select2');
                    $sel.trigger('change');
                }
            }
        },
        BU_SELECT_SELECTOR,
        target.value
    );
    await delay(350);

    let state = await readBuState(page);
    if (state.exists && state.value === target.value) {
        console.log(`[filters] business unit set to "${state.text}" (value ${state.value}) via native set.`);
        return state.text;
    }

    console.log(
        `[filters] business unit: native set did not stick (current value="${state && state.value}", target="${target.value}"). Falling back to Select2 click flow.`
    );

    try {
        await clickElement(
            page,
            [
                "//span[contains(@class, 'select2-selection') and @title='Business Unit']",
                "//select[contains(@id,'ddlBunit')]/following::span[contains(@class,'select2-selection')][1]",
                "//select[contains(@id,'BusinessUnit')]/following::span[contains(@class,'select2-selection')][1]"
            ],
            { retries: 3, waitTimeout: 8000 }
        );
        await delay(450);
        await clickElement(
            page,
            [
                `//li[contains(@class, 'select2-results__option') and normalize-space(text())=${escapeXPathText(target.text)}]`,
                `//li[contains(@class, 'select2-results__option') and contains(text(), ${escapeXPathText(target.text)})]`,
                `//li[contains(@class, 'select2-results__option') and contains(translate(normalize-space(text()), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), ${escapeXPathText(target.text.toLowerCase())})]`
            ],
            { retries: 4, waitTimeout: 6000 }
        );
        await delay(350);
    } catch (e) {
        console.log(`[filters] business unit: Select2 click flow failed (${e.message})`);
    }

    state = await readBuState(page);
    if (state.exists && state.value === target.value) {
        console.log(`[filters] business unit set to "${state.text}" (value ${state.value}) via Select2 click.`);
        return state.text;
    }

    console.log(
        `[filters] business unit: did not apply (still value="${state && state.value}" rendered="${state && state.rendered}").`
    );
    return null;
}

/**
 * @param {import('puppeteer').Page} page
 */
async function setTestCode(page, testCode) {
    if (!testCode || !String(testCode).trim()) {
        console.log('[filters] test code: skipped (no value)');
        return false;
    }
    const ok = await page.evaluate((code) => {
        const input =
            document.querySelector("input[id*='txtTestcode']") || document.querySelector("input[name*='txtTestcode']");
        if (!input) return false;
        input.value = String(code);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    }, testCode);
    if (ok) await delay(150);
    if (!ok) console.log('[filters] test code: input not found');
    return ok;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {'txtFdate'|'txtTodate'} idSub
 * @param {string} dateStr DD/MM/YYYY
 */
async function setWorksheetDate(page, idSub, dateStr) {
    if (!dateStr || !String(dateStr).trim()) return false;
    const ok = await page.evaluate(
        (idFragment, val) => {
            const input = document.querySelector(`input[id*='${idFragment}']`);
            if (!input) return false;
            input.value = val;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        },
        idSub,
        dateStr
    );
    if (ok) await delay(200);
    return ok;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {number} hour
 * @param {'from'|'to'} which
 */
async function setHourSelect(page, hour, which) {
    if (hour == null || !Number.isFinite(Number(hour))) return false;
    const want = String(Number(hour));
    const ok = await page.evaluate(
        (h, mode) => {
            const sel = Array.from(document.querySelectorAll('select')).find((s) => {
                const id = (s.id || '').toLowerCase();
                const nm = (s.getAttribute('name') || '').toLowerCase();
                if (mode === 'from') return id.includes('ddlftime') && !id.includes('ddlftime0');
                return id.includes('ddlftime0') || nm.includes('ddlftime0');
            });
            if (!sel) return false;
            const opts = Array.from(sel.options || []);
            const target = opts.find(
                (o) => String(o.value).trim() === h || String(o.textContent || o.text || '').trim() === h
            );
            if (!target) return false;
            sel.value = target.value;
            sel.dispatchEvent(new Event('change', { bubbles: true }));
            if (window.jQuery && window.jQuery(sel).data('select2')) {
                window.jQuery(sel).val(target.value).trigger('change');
            }
            return true;
        },
        want,
        which
    );
    if (ok) await delay(200);
    return ok;
}

/**
 * Department / dept no — numeric value or substring of option text.
 * @param {import('puppeteer').Page} page
 * @param {string} dept
 */
async function setDepartment(page, dept) {
    if (!dept || !String(dept).trim()) {
        console.log('[filters] dept: skipped (no value)');
        return false;
    }
    const raw = String(dept).trim();
    const ok = await page.evaluate((token) => {
        const sel = document.querySelector('select[id*="ddlDeptNo"], select[name*="ddlDeptNo"]');
        if (!sel) return false;
        const opts = Array.from(sel.options || []);
        let target = null;
        if (/^\d+$/.test(token)) {
            target = opts.find((o) => String(o.value).trim() === token);
        }
        if (!target) {
            const low = token.toLowerCase();
            target = opts.find((o) => (o.text || '').toLowerCase().includes(low));
        }
        if (!target) return false;
        sel.value = target.value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery && window.jQuery(sel).data('select2')) {
            window.jQuery(sel).val(target.value).trigger('change');
        }
        return true;
    }, raw);
    if (ok) await delay(220);
    if (!ok) console.log(`[filters] dept: could not set "${raw}"`);
    return ok;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {'clientCode'|'sid'|'vailId'|'pid'} kind
 * @param {string} value
 */
async function setTextFilter(page, kind, value) {
    if (!value || !String(value).trim()) {
        console.log(`[filters] ${kind}: skipped (no value)`);
        return false;
    }
    const idHints =
        kind === 'clientCode'
            ? ['txtClient', 'ClientCode', 'clientcode', 'Client']
            : kind === 'sid'
              ? ['txtSid', 'txtsid', 'TxtSid', 'SID']
              : kind === 'vailId'
                ? ['txtvailid', 'txtVailid', 'Vailid', 'vailid']
                : ['txtPid', 'txtPID', 'PID', 'pid'];

    const ok = await page.evaluate(
        (token, hints, kindStr) => {
            /** @type {HTMLInputElement | null} */
            let el = null;
            for (const h of hints) {
                el = document.querySelector(`input[id*="${h}"]`);
                if (el) break;
            }
            if (!el) {
                const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
                for (const inp of inputs) {
                    const id = (inp.id || '').toLowerCase();
                    if (kindStr === 'vailId' && id.includes('vail')) {
                        el = inp;
                        break;
                    }
                    if (kindStr === 'sid' && id.includes('sid') && !id.includes('vail')) {
                        el = inp;
                        break;
                    }
                    if (kindStr === 'pid' && id.includes('pid')) {
                        el = inp;
                        break;
                    }
                    if (kindStr === 'clientCode' && id.includes('client')) {
                        el = inp;
                        break;
                    }
                }
            }
            if (!el) return false;
            el.value = String(token);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        },
        String(value).trim(),
        idHints,
        kind
    );
    if (ok) await delay(150);
    if (!ok) console.log(`[filters] ${kind}: no matching input found`);
    return ok;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {object} f
 */
async function applyFilters(page, f) {
    const applied = {};
    if (f.bu) applied.businessUnit = await setBusinessUnitByLabel(page, f.bu);
    if (f.status) applied.status = (await setStatusByLabel(page, f.status)) ? f.status : null;
    if (f.testCode) applied.testCode = (await setTestCode(page, f.testCode)) ? f.testCode : null;
    if (f.fromDate) applied.fromDate = (await setWorksheetDate(page, 'txtFdate', f.fromDate)) ? f.fromDate : null;
    if (f.toDate) applied.toDate = (await setWorksheetDate(page, 'txtTodate', f.toDate)) ? f.toDate : null;
    if (f.fromHour != null && Number.isFinite(Number(f.fromHour)))
        applied.fromHour = (await setHourSelect(page, Number(f.fromHour), 'from')) ? f.fromHour : null;
    if (f.toHour != null && Number.isFinite(Number(f.toHour)))
        applied.toHour = (await setHourSelect(page, Number(f.toHour), 'to')) ? f.toHour : null;
    if (f.deptNo) applied.deptNo = (await setDepartment(page, f.deptNo)) ? f.deptNo : null;
    if (f.clientCode) applied.clientCode = (await setTextFilter(page, 'clientCode', f.clientCode)) ? f.clientCode : null;
    if (f.sid) applied.sidFilter = (await setTextFilter(page, 'sid', f.sid)) ? f.sid : null;
    if (f.vailId) applied.vailId = (await setTextFilter(page, 'vailId', f.vailId)) ? f.vailId : null;
    if (f.pid) applied.pid = (await setTextFilter(page, 'pid', f.pid)) ? f.pid : null;

    return applied;
}

module.exports = {
    applyFilters,
    readBuState,
    setBusinessUnitByLabel,
    setStatusByLabel,
    setTestCode,
    setWorksheetDate,
    setHourSelect,
    setDepartment,
    setTextFilter
};
