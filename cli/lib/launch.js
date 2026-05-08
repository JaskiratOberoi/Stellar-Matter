'use strict';

const puppeteer = require('puppeteer');

/**
 * @param {{ headless: boolean, executablePath?: string }} opts
 */
async function launchBrowser(opts) {
    const { headless, executablePath } = opts;
    const args = headless
        ? [
              '--no-sandbox',
              '--disable-setuid-sandbox',
              '--window-size=1920,1080',
              '--disable-dev-shm-usage',
              '--no-first-run',
              '--no-default-browser-check'
          ]
        : ['--start-maximized'];

    const launchOpts = {
        headless: headless ? 'new' : false,
        defaultViewport: null,
        args
    };
    if (executablePath) {
        launchOpts.executablePath = executablePath;
        console.log(`Using Chromium executable: ${executablePath}`);
    }
    return puppeteer.launch(launchOpts);
}

module.exports = { launchBrowser };
