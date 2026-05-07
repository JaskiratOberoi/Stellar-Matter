'use strict';

const { delay } = require('./dom');

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

/**
 * @param {import('puppeteer').Page} page
 * @param {string} businessUnit - visible option text or value fragment
 */
async function setBusinessUnitByLabel(page, businessUnit) {
    if (!businessUnit || !String(businessUnit).trim()) {
        console.log('[filters] business unit: skipped (no value)');
        return false;
    }
    const ok = await page.evaluate((bu) => {
        const select = document.querySelector(
            'select[id*="ddlBunit"], select[name*="ddlBunit"], select[id*="BusinessUnit"], select[name*="BusinessUnit"]'
        );
        if (!select) return false;
        const options = Array.from(select.options || []);
        const matchingOption = options.find(
            (opt) =>
                opt.text.trim() === bu ||
                opt.value === bu ||
                (opt.text || '').trim().includes(bu)
        );
        if (!matchingOption) return false;
        select.value = matchingOption.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery && window.jQuery(select).data('select2')) {
            window.jQuery(select).val(matchingOption.value).trigger('change');
        }
        return true;
    }, businessUnit);
    if (ok) await delay(220);
    if (!ok) console.log(`[filters] business unit: could not match "${businessUnit}"`);
    return ok;
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
    if (f.bu) applied.businessUnit = (await setBusinessUnitByLabel(page, f.bu)) ? f.bu : null;
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
    setBusinessUnitByLabel,
    setStatusByLabel,
    setTestCode,
    setWorksheetDate,
    setHourSelect,
    setDepartment,
    setTextFilter
};
