'use strict';

// Renders challan / receiving-slip HTML to an A4 PDF with the headless
// Chromium already in the API image (PUPPETEER_EXECUTABLE_PATH). Printing
// from the browser instead left the result to whatever printer the user
// picked, and "Microsoft Print to PDF" turned the text into rough outlines.

const puppeteer = require('puppeteer');
const { challanHtml, receivingHtml } = require('./challanDocs');

// One browser, started on first use and reused; a page per render.
let browserPromise = null;

function getBrowser() {
    if (!browserPromise) {
        const opts = {
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-first-run']
        };
        const exe = process.env.PUPPETEER_EXECUTABLE_PATH || process.env.LIS_CHROMIUM_EXECUTABLE_PATH;
        if (exe) opts.executablePath = exe;
        browserPromise = puppeteer.launch(opts).then((b) => {
            b.on('disconnected', () => {
                browserPromise = null;
            });
            return b;
        });
        browserPromise.catch(() => {
            browserPromise = null;
        });
    }
    return browserPromise;
}

/** @param {'challan'|'slip'} kind */
async function renderChallanPdf(challan, kind) {
    const html = kind === 'slip' ? receivingHtml(challan) : challanHtml(challan);
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
        await page.setJavaScriptEnabled(false);
        await page.setContent(html, { waitUntil: 'load' });
        return await page.pdf({ format: 'A4', preferCSSPageSize: true, printBackground: true });
    } finally {
        await page.close().catch(() => {});
    }
}

module.exports = { renderChallanPdf };
