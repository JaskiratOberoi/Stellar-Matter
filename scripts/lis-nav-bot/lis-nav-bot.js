#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { Command } = require('commander');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { launchBrowser } = require('./lib/launch');
const { loginAndOpenWorksheet } = require('./lib/login');
const { applyFilters } = require('./lib/filters');
const { clickSearch, waitForSampleGrid, listSidsForCurrentPage, getSampleGridPagerInfo } = require('./lib/grid');
const { openSid, dumpWorksheetRows, closeModal } = require('./lib/modal');

const DEFAULT_BACKUP_LOGIN = 'http://192.168.1.51:88/login.aspx?ReturnUrl=%2f';

function pickStr(envKey, cliVal) {
    if (cliVal !== undefined && cliVal !== null && String(cliVal).trim() !== '') return String(cliVal).trim();
    const e = process.env[envKey];
    if (e !== undefined && String(e).trim() !== '') return String(e).trim();
    return undefined;
}

function pickNum(envKey, cliVal) {
    if (cliVal !== undefined && cliVal !== null && String(cliVal).trim() !== '') return Number(cliVal);
    const e = process.env[envKey];
    if (e !== undefined && String(e).trim() !== '') return Number(e);
    return undefined;
}

function resolveCredentials() {
    const username =
        pickStr('LIS_LOGIN_USERNAME', undefined) ||
        process.env.CBC_LOGIN_USERNAME ||
        process.env.LOGIN_USERNAME;
    const password =
        pickStr('LIS_LOGIN_PASSWORD', undefined) ||
        process.env.CBC_LOGIN_PASSWORD ||
        process.env.LOGIN_PASSWORD;
    return { username, password };
}

function resolveUrls() {
    const primary =
        pickStr('LIS_TARGET_URL', undefined) || pickStr('TARGET_URL', undefined) || process.env.LIS_PRIMARY_LOGIN_URL;
    const backup = pickStr('LIS_BACKUP_LOGIN_URL', undefined) || process.env.LIS_BACKUP_LOGIN_URL || DEFAULT_BACKUP_LOGIN;
    return { primary, backup };
}

async function main() {
    const program = new Command();
    program
        .name('lis-nav-bot')
        .description('Read-only LIS Sample Worksheet navigation (no worksheet writes)')
        .option('--bu <name>', 'Business unit label')
        .option('--status <label>', 'Worksheet status label')
        .option('--test-code <code>', 'Test code filter')
        .option('--from-date <DD/MM/YYYY>', 'From date')
        .option('--to-date <DD/MM/YYYY>', 'To date')
        .option('--from-hour <0-23>', 'From hour', (v) => Number(v))
        .option('--to-hour <0-23>', 'To hour', (v) => Number(v))
        .option('--client-code <code>', 'Client code')
        .option('--sid <sid>', 'SID search field')
        .option('--vail-id <id>', 'Vail / valid id')
        .option('--pid <pid>', 'PID')
        .option('--dept-no <no>', 'Department (numeric code or name substring)')
        .option('--open-sid <sid>', 'After search, open this SID worksheet modal (read-only)')
        .option('--max-sids <n>', 'Max SIDs to collect from page 1', (v) => parseInt(v, 10), 25)
        .option('--headless', 'Run headless Chromium', false)
        .option('--dry-run', 'Login + filters only; do not click Search', false)
        .option('--out-dir <dir>', 'Output directory', process.env.LIS_OUT_DIR || './out')
        .option('--no-screenshots', 'Skip PNG screenshots', false)
        .option('--skip-regional-badge', 'Skip gvSample rows with regional mcc badge (QUGEN pattern)', false)
        .parse(process.argv);

    const opts = program.opts();

    if (process.env.LIS_ALLOW_WRITES === '1') {
        console.error(
            'LIS_ALLOW_WRITES=1 is set. This read-only tool refuses to run when that flag is present. Unset it to continue.'
        );
        process.exit(1);
    }

    console.log('READ-ONLY MODE — no LIS writes will be performed.');

    const { username, password } = resolveCredentials();
    if (!username || !password) {
        console.error('Missing credentials. Set LIS_LOGIN_USERNAME and LIS_LOGIN_PASSWORD in .env (or use CBC_* / LOGIN_* fallbacks).');
        process.exit(1);
    }

    const { primary, backup } = resolveUrls();
    if (!primary) {
        console.error('Missing LIS_TARGET_URL (or TARGET_URL) in environment / .env.');
        process.exit(1);
    }

    const headless =
        !!opts.headless ||
        String(process.env.LIS_HEADLESS || '')
            .toLowerCase()
            .trim() === 'true';

    const outDir = path.isAbsolute(opts.outDir) ? opts.outDir : path.resolve(process.cwd(), opts.outDir);
    const screenshotsDir = path.join(outDir, 'screenshots');
    const takeShots = !opts.noScreenshots && String(process.env.LIS_SCREENSHOTS || '1') !== '0';

    const filters = {
        bu: pickStr('LIS_BU', opts.bu),
        status: pickStr('LIS_STATUS', opts.status),
        testCode: pickStr('LIS_TEST_CODE', opts.testCode),
        fromDate: pickStr('LIS_FROM_DATE', opts.fromDate),
        toDate: pickStr('LIS_TO_DATE', opts.toDate),
        fromHour: pickNum('LIS_FROM_HOUR', opts.fromHour),
        toHour: pickNum('LIS_TO_HOUR', opts.toHour),
        clientCode: pickStr('LIS_CLIENT_CODE', opts.clientCode),
        sid: pickStr('LIS_SID', opts.sid),
        vailId: pickStr('LIS_VAIL_ID', opts.vailId),
        pid: pickStr('LIS_PID', opts.pid),
        deptNo: pickStr('LIS_DEPT_NO', opts.deptNo)
    };

    const openSidValue = pickStr('LIS_OPEN_SID', opts.openSid);
    const rawMax = opts.maxSids;
    const maxSids =
        Number.isFinite(rawMax) && !Number.isNaN(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 25;
    const dryRun =
        !!opts.dryRun ||
        String(process.env.LIS_DRY_RUN || '')
            .toLowerCase()
            .trim() === '1';
    const skipRegional =
        !!opts.skipRegionalBadge ||
        String(process.env.LIS_SKIP_REGIONAL_BADGE || '').trim() === '1';

    const execPath = (process.env.LIS_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || '').trim() || undefined;

    const browser = await launchBrowser({ headless, executablePath: execPath });
    const startedAt = new Date().toISOString();

    const result = {
        startedAt,
        readOnly: true,
        primaryUrl: primary,
        backupUrlUsed: false,
        filtersRequested: { ...filters },
        filtersApplied: {},
        dryRun,
        pager: null,
        sidsFoundOnPage1: [],
        openedSid: null,
        errors: []
    };

    let page;
    try {
        page = await browser.newPage();
        await loginAndOpenWorksheet(page, primary, backup, username, password);

        result.filtersApplied = await applyFilters(page, filters);

        if (dryRun) {
            console.log('[dry-run] Would click Search — exiting without searching.');
            result.message = 'dry-run: stopped before Search';
        } else {
            const searched = await clickSearch(page);
            if (!searched) {
                result.errors.push('Search click did not find a control');
            }
            await waitForSampleGrid(page);

            if (takeShots) {
                try {
                    fs.mkdirSync(screenshotsDir, { recursive: true });
                    const stamp = startedAt.replace(/[:.]/g, '-');
                    const p = path.join(screenshotsDir, `${stamp}-grid.png`);
                    await page.screenshot({ path: p, fullPage: true });
                    result.screenshotGrid = p;
                } catch (e) {
                    result.errors.push(`screenshot grid: ${e.message}`);
                }
            }

            result.pager = await getSampleGridPagerInfo(page);
            let sids = await listSidsForCurrentPage(page, { skipRegionalBadge: skipRegional });
            sids = sids.slice(0, maxSids);
            result.sidsFoundOnPage1 = sids;

            if (openSidValue) {
                if (!sids.includes(String(openSidValue).trim())) {
                    console.log(
                        `Note: open-sid ${openSidValue} is not in the first-page SID list (${sids.length} shown); attempting click anyway.`
                    );
                }
                try {
                    await openSid(page, String(openSidValue).trim());
                    const rows = await dumpWorksheetRows(page);
                    result.openedSid = { sid: String(openSidValue).trim(), rows };
                    if (takeShots) {
                        try {
                            const stamp = startedAt.replace(/[:.]/g, '-');
                            const p = path.join(screenshotsDir, `${stamp}-modal.png`);
                            await page.screenshot({ path: p, fullPage: true });
                            result.screenshotModal = p;
                        } catch (e) {
                            result.errors.push(`screenshot modal: ${e.message}`);
                        }
                    }
                    await closeModal(page);
                } catch (e) {
                    result.errors.push(`open-sid: ${e.message}`);
                }
            }
        }

        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}.json`);
        fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
        console.log(`Wrote ${outFile}`);
        console.log(`SIDs (page 1, max ${maxSids}): ${JSON.stringify(result.sidsFoundOnPage1)}`);
    } catch (e) {
        result.errors.push(String(e && e.message ? e.message : e));
        console.error(e);
        try {
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}-error.json`);
            fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');
        } catch (_) {}
        process.exitCode = 1;
    } finally {
        await browser.close().catch(() => {});
    }
}

main();
