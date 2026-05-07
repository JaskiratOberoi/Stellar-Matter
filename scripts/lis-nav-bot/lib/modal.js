'use strict';

const { clickElement, escapeXPathText, delay } = require('./dom');

async function isWorksheetModalVisible(page) {
    return page.evaluate(() => {
        const table = document.querySelector("table[id*='gvWorksheet']");
        if (!table) return false;
        const vis = (el) => {
            if (!el) return false;
            if (el.hidden) return false;
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        };
        if (!vis(table)) return false;
        let parent = table.parentElement;
        while (parent) {
            if (!vis(parent)) return false;
            parent = parent.parentElement;
        }
        return true;
    });
}

async function waitForWorksheetModalOpen(page, timeoutMs = 12000) {
    try {
        await page.waitForFunction(
            () => {
                const table = document.querySelector("table[id*='gvWorksheet']");
                if (!table) return false;
                const style = window.getComputedStyle(table);
                const rect = table.getBoundingClientRect();
                return (
                    style.display !== 'none' &&
                    style.visibility !== 'hidden' &&
                    rect.width > 0 &&
                    rect.height > 0
                );
            },
            { timeout: timeoutMs }
        );
    } catch (_) {
        await delay(400);
    }
}

/**
 * Read-only: test names and displayed values (no edits).
 * @param {import('puppeteer').Page} page
 */
async function dumpWorksheetRows(page) {
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table[id*="gvWorksheet"] tbody tr'));
        return rows
            .map((row) => {
                const nameNode = row.querySelector('span[id*="lblTestname"]') || row.querySelector('td');
                const valueNode = row.querySelector('textarea[id*="txtValue"], input[id*="txtValue"]');
                const label = nameNode ? String(nameNode.textContent || '').trim() : '';
                const value = valueNode ? String(valueNode.value || valueNode.textContent || '').trim() : '';
                return { label, value };
            })
            .filter((r) => r.label || r.value);
    });
}

/**
 * @param {import('puppeteer').Page} page
 * @param {string} sid
 */
async function openSid(page, sid) {
    const lit = escapeXPathText(sid);
    await clickElement(
        page,
        [`//a[normalize-space(text())=${lit}]`, `//tr//a[contains(normalize-space(text()), ${lit})]`],
        { retries: 2, waitTimeout: 2000 }
    );
    await waitForWorksheetModalOpen(page, 10000);
}

/**
 * @param {import('puppeteer').Page} page
 */
async function closeModal(page) {
    const modalVisible = await isWorksheetModalVisible(page);
    if (!modalVisible) return true;

    const closedViaImageButton = await page.evaluate(() => {
        const button =
            document.querySelector("input[type='image'][id*='ImageButton1']") ||
            document.querySelector("input[type='image'][name*='ImageButton1']") ||
            document.querySelector("td[align='right'][width='1'] input[type='image'][src*='Close.gif']");
        if (!button) return false;
        button.removeAttribute('disabled');
        if (typeof button.click === 'function') button.click();
        button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
    }).catch(() => false);
    if (closedViaImageButton) await delay(300);

    try {
        await clickElement(
            page,
            [
                "//input[@type='image' and contains(@id, 'ImageButton1')]",
                "//input[@type='image' and contains(@name, 'ImageButton1')]",
                "//td[@align='right' and @width='1']//input[@type='image' and contains(@src, 'Close.gif')]",
                "//a[contains(@id, 'lnkClose') and normalize-space(text())='X']",
                "//a[contains(@id, 'lnkClose')]",
                "//a[contains(@class, 'btn-danger') and normalize-space(text())='X']"
            ],
            { retries: 2, waitTimeout: 1200 }
        );
    } catch (_) {}

    await page.keyboard.press('Escape').catch(() => {});
    await page.evaluate(() => {
        const modal = document.querySelector("table[id*='gvWorksheet']");
        if (modal) {
            const wraps = [modal.closest('.modal'), modal.closest('.modal-dialog'), modal.closest('.modal-content')].filter(
                Boolean
            );
            for (const wrap of wraps) {
                wrap.style.display = 'none';
                wrap.setAttribute('aria-hidden', 'true');
            }
        }
        const backdrop = document.querySelector('.modal-backdrop');
        if (backdrop) backdrop.remove();
        document.body.classList.remove('modal-open');
    }).catch(() => {});

    await delay(250);
    const stillVisible = await isWorksheetModalVisible(page);
    return !stillVisible;
}

module.exports = {
    isWorksheetModalVisible,
    waitForWorksheetModalOpen,
    dumpWorksheetRows,
    openSid,
    closeModal
};
