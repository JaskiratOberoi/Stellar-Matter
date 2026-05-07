'use strict';

/** @param {number} ms */
function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function escapeXPathText(value) {
    const text = String(value ?? '');
    if (!text.includes("'")) return `'${text}'`;
    if (!text.includes('"')) return `"${text}"`;
    const parts = text.split("'").map((part) => `'${part}'`);
    return `concat(${parts.join(`, "'", `)})`;
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string[]} xpaths
 * @param {number} timeout
 */
async function waitForElement(page, xpaths, timeout = 10000) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeout) {
        for (const xpath of xpaths) {
            try {
                const handles = await page.$x(xpath);
                if (handles && handles.length > 0) {
                    const h = handles[0];
                    for (let i = 1; i < handles.length; i++) {
                        if (typeof handles[i].dispose === 'function') handles[i].dispose();
                    }
                    return h;
                }
            } catch (_) {}
        }
        await delay(120);
    }
    throw new Error(`Element not found for XPaths: ${xpaths.join(' | ')}`);
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string[]} xpaths
 * @param {{ retries?: number, waitTimeout?: number }} [options]
 */
async function clickElement(page, xpaths, options = {}) {
    const retries = Number(options.retries ?? 3);
    const waitTimeout = Number(options.waitTimeout ?? 8000);
    let lastError = null;
    for (let attempt = 0; attempt < retries; attempt += 1) {
        try {
            const handle = await waitForElement(page, xpaths, waitTimeout);
            await page.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }), handle);
            await delay(80);
            try {
                await handle.click({ delay: 40 });
            } catch (_) {
                await page.evaluate((el) => {
                    if (!el) return;
                    el.removeAttribute('disabled');
                    el.removeAttribute('readonly');
                    if (typeof el.click === 'function') el.click();
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }, handle);
            }
            if (typeof handle.dispose === 'function') await handle.dispose();
            return;
        } catch (error) {
            lastError = error;
            await delay(150);
        }
    }
    throw lastError || new Error('clickElement failed');
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string[]} xpaths
 * @param {string} value
 */
async function typeElement(page, xpaths, value) {
    const handle = await waitForElement(page, xpaths, 8000);
    await handle.click({ clickCount: 3, delay: 25 });
    await page.keyboard.press('Backspace');
    await handle.type(String(value ?? ''), { delay: 15 });
    if (typeof handle.dispose === 'function') await handle.dispose();
}

module.exports = {
    delay,
    escapeXPathText,
    waitForElement,
    clickElement,
    typeElement
};
