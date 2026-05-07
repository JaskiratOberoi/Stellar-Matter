'use strict';

const { clickElement, typeElement, delay } = require('./dom');

/**
 * @param {import('puppeteer').Page} page
 * @param {string} primaryUrl
 * @param {string} backupUrl
 * @param {string} username
 * @param {string} password
 */
async function loginAndOpenWorksheet(page, primaryUrl, backupUrl, username, password) {
    try {
        await page.goto(primaryUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    } catch (_) {
        console.log('Primary login URL failed, trying backup...');
        await page.goto(backupUrl, { waitUntil: 'networkidle2', timeout: 45000 });
    }

    await typeElement(page, ["//input[@type='text']"], username);
    await typeElement(page, ["//input[@type='password']"], password);
    await clickElement(page, [
        "//button[contains(text(), 'Login')]",
        "//input[@type='submit' and contains(@value, 'Login')]",
        "//button[@type='submit']",
        "//input[@type='submit']"
    ]);

    await page
        .waitForFunction(() => document.querySelector('nav#sidebar'), { timeout: 20000 })
        .catch(() => delay(2000));

    await clickElement(page, [
        "//nav[@id='sidebar']//a[@data-toggle='collapse' and @href='#Worksheet']",
        "//a[@data-toggle='collapse' and @href='#Worksheet']"
    ]);
    await delay(500);

    let submenuClicked = false;
    try {
        await clickElement(page, [
            "//ul[@id='Worksheet']//a[contains(@href, 'Sampleworksheet.aspx')]",
            "//ul[@id='Worksheet']//a[contains(@href, 'Sampleworksheet')]",
            "//ul[@id='Worksheet']//a[normalize-space(text())='Worksheet']",
            "//a[contains(translate(@href, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'sampleworksheet')]"
        ]);
        submenuClicked = true;
    } catch (_) {}

    if (!submenuClicked) {
        const opened = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const target = links.find((a) => {
                const href = String(a.getAttribute('href') || '').toLowerCase();
                const text = String(a.textContent || '').trim().toLowerCase();
                return href.includes('sampleworksheet') || (text === 'worksheet' && href.includes('worksheet'));
            });
            if (!target) return false;
            target.click();
            return true;
        });
        if (!opened) {
            throw new Error('Could not open Worksheet submenu (Sampleworksheet.aspx)');
        }
    }
    await delay(1800);
}

module.exports = { loginAndOpenWorksheet };
