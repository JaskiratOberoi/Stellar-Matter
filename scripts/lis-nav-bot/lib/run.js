'use strict';

const fs = require('fs');
const path = require('path');

// Stamp org_id on every run artefact so /api/runs/tiles can scope to the
// caller's active org. Pre-org files are read as 'org-default' (Phase 10).
function writeRunFile(filePath, payload, orgId) {
    const stamped =
        payload && typeof payload === 'object' && !Array.isArray(payload)
            ? Object.assign({ org_id: orgId || 'org-default' }, payload)
            : payload;
    fs.writeFileSync(filePath, JSON.stringify(stamped, null, 2), 'utf8');
}

const { delay } = require('./dom');
const { launchBrowser } = require('./launch');
const { loginAndOpenWorksheet } = require('./login');
const { applyFilters, readBuState } = require('./filters');
const {
    clickSearch,
    waitForSampleGrid,
    listSidsForCurrentPage,
    getSampleGridPagerInfo,
    scrapeSampleRowsWithTestNames,
    goToNextSampleGridPage,
    verifyWorksheetSession,
    jumpToSampleGridPage
} = require('./grid');
const { aggregateRows, countRowsWithBracketLabels } = require('./packages');
const { openSid, dumpWorksheetRows, closeModal } = require('./modal');

const DEFAULT_BACKUP_LOGIN = 'http://192.168.1.51:88/login.aspx?ReturnUrl=%2f';

/** Internal safety cap only — prevents runaway pagination if the grid never reports "no next page". */
const HARD_SCRAPE_PAGE_LIMIT = 10000;

const MAX_SCRAPE_SESSION_RECOVERIES = 3;
const SCRAPE_SESSION_RECOVERY_BACKOFF_MS = [1500, 4000, 9000];

/**
 * @param {string} msg
 */
function isSessionEvaluateDestroyed(msg) {
    return /Execution context was destroyed|detached Frame|Target closed/i.test(String(msg || ''));
}

/**
 * @param {import('puppeteer').Page} page
 * @param {() => Promise<T>} fn
 * @template T
 * @returns {Promise<T>}
 */
async function guardedEvaluateChain(page, fn) {
    try {
        const out = await fn();
        if (page.isClosed()) {
            const e = /** @type {Error & {__sessionLost?: boolean}} */ (new Error('Page closed'));
            e.__sessionLost = true;
            throw e;
        }
        return out;
    } catch (e) {
        const msg = String(e && e.message ? e.message : e);
        if (isSessionEvaluateDestroyed(msg) || /Protocol error/i.test(msg)) {
            const wrap = /** @type {Error & {__sessionLost?: boolean}} */ (e instanceof Error ? e : new Error(msg));
            wrap.__sessionLost = true;
            throw wrap;
        }
        throw e;
    }
}

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

function resolveScrapePackages(cliFlag) {
    if (cliFlag) return true;
    const v = process.env.LIS_SCRAPE_PACKAGES;
    return v === '1' || /^true$/i.test(String(v || '').trim());
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

function assertReadOnlyAllowed() {
    if (process.env.LIS_ALLOW_WRITES === '1') {
        const err = new Error(
            'LIS_ALLOW_WRITES=1 is set. This read-only tool refuses to run when that flag is present. Unset it to continue.'
        );
        err.code = 'LIS_ALLOW_WRITES';
        throw err;
    }
}

/**
 * @param {object} programOpts - same shape as commander `opts` (camelCase)
 * @returns {Promise<{ result: object, outMainPath: string | null, outPackagesPath: string | null, exitCode: number }>}
 */
async function runLisNavBot(programOpts) {
    assertReadOnlyAllowed();

    const opts = programOpts || {};

    const sourceRaw = pickStr('LIS_SOURCE', opts.source);
    const source = sourceRaw && /^sql$/i.test(sourceRaw) ? 'sql' : 'scrape';
    if (source === 'sql') {
        const { runViaSql } = require('./sql-source');
        return runViaSql(opts);
    }

    const { username, password } = resolveCredentials();
    if (!username || !password) {
        const err = new Error(
            'Missing credentials. Set username/password in scripts/lis-nav-bot/.env or the repository root .env. ' +
                'Names (reference-style): LIS_LOGIN_USERNAME / LIS_LOGIN_PASSWORD, or CBC_LOGIN_USERNAME / CBC_LOGIN_PASSWORD, or LOGIN_USERNAME / LOGIN_PASSWORD.'
        );
        err.code = 'MISSING_CREDENTIALS';
        throw err;
    }

    const { primary, backup } = resolveUrls();
    if (!primary) {
        const err = new Error('Missing LIS_TARGET_URL (or TARGET_URL) in environment / .env.');
        err.code = 'MISSING_URL';
        throw err;
    }

    const headless =
        !!opts.headless ||
        String(process.env.LIS_HEADLESS || '')
            .toLowerCase()
            .trim() === 'true';

    const outDirRaw = opts.outDir != null ? opts.outDir : process.env.LIS_OUT_DIR || './out';
    const outDir = path.isAbsolute(String(outDirRaw)) ? String(outDirRaw) : path.resolve(process.cwd(), String(outDirRaw));
    const screenshotsDir = path.join(outDir, 'screenshots');

    // org_id from caller (server passes req.user.activeOrgId), env, or fallback.
    const orgId = opts.orgId != null ? String(opts.orgId) : process.env.LIS_ORG_ID || 'org-default';
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

    const scrapePackages = resolveScrapePackages(!!opts.scrapePackages);

    const openSidValue = scrapePackages ? undefined : pickStr('LIS_OPEN_SID', opts.openSid);
    if (scrapePackages && (opts.openSid || (process.env.LIS_OPEN_SID && String(process.env.LIS_OPEN_SID).trim()))) {
        console.log('[packages] --open-sid / LIS_OPEN_SID is ignored when --scrape-packages is active.');
    }
    const dryRun =
        !!opts.dryRun ||
        String(process.env.LIS_DRY_RUN || '')
            .toLowerCase()
            .trim() === '1';
    const skipRegional =
        !!opts.skipRegionalBadge ||
        String(process.env.LIS_SKIP_REGIONAL_BADGE || '').trim() === '1';

    const execPath = (process.env.LIS_CHROMIUM_EXECUTABLE_PATH || process.env.CHROMIUM_EXECUTABLE_PATH || '').trim() || undefined;

    let startedAt = new Date().toISOString();
    if (opts.startedAt != null && String(opts.startedAt).trim() !== '') {
        const t = new Date(String(opts.startedAt));
        if (!Number.isNaN(t.getTime())) startedAt = t.toISOString();
    }

    /** @type {object} */
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
        scrapePackages: scrapePackages
            ? { enabled: true, pagesScanned: 0, rowCount: 0, packagesJsonPath: null }
            : { enabled: false },
        errors: []
    };

    let outMainPath = null;
    let outPackagesPath = null;
    let exitCode = 0;

    /** @type {import('puppeteer').Browser | undefined} */
    let browser;
    let page;
    try {
        browser = await launchBrowser({ headless, executablePath: execPath });
        page = await browser.newPage();
        await loginAndOpenWorksheet(page, primary, backup, username, password);

        result.filtersApplied = await applyFilters(page, filters);
        /** After filters, BU select value is stable while session holds (recovery re-reads each time). */
        let buCanarySelectValue = /** @type {string|null} */ (null);
        if (!dryRun && filters.bu && result.filtersApplied && result.filtersApplied.businessUnit) {
            const rs = await readBuState(page);
            if (rs.exists) buCanarySelectValue = rs.value;
        }

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

            if (scrapePackages) {
                const gridOpts = { skipRegionalBadge: skipRegional };
                const page1Sids = await listSidsForCurrentPage(page, gridOpts);
                result.sidsFoundOnPage1 = [...page1Sids];

                const rowsAll = [];
                /** @type {{ index: number, pagerPage: number|null, rowCount: number, rowsWithBracketLabels: number }[]} */
                const pageVisits = [];
                const completedPagerPages = new Set();
                /** @type {{ attempt: number, reason: string, atPagerPage: number|null, at: string, succeeded: boolean, error?: string }[]} */
                const recoveryEvents = [];
                /** @type {number|null} */
                let lastCompletedPagerPage = null;
                let recoveryAttemptsUsed = 0;
                let pagesScanned = 0;
                /** @type {boolean} */
                let hasMorePages = true;

                fs.mkdirSync(outDir, { recursive: true });
                const pkgFile = path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}-packages.json`);

                const scrapePayloadPartial = () => {
                    const agg = aggregateRows(rowsAll);
                    return {
                        startedAt,
                        filter: { ...filters },
                        filtersApplied: result.filtersApplied,
                        pagesScanned,
                        pageVisits,
                        rowCount: rowsAll.length,
                        uniqueLabelCount: agg.uniqueLabelCount,
                        labelToSids: agg.labelToSids,
                        labelOccurrences: agg.labelOccurrences,
                        otherTestsRowCount: agg.otherTestsRowCount,
                        recoveryEvents,
                        completedPagerPages: [...completedPagerPages].sort((a, b) => a - b),
                        lastCompletedPagerPage,
                        partial: true,
                        partialAt: new Date().toISOString()
                    };
                };

                /** @returns {Promise<boolean>} true if scraping may continue */
                async function recoverWorksheetSession(reason) {
                    const attemptIx = recoveryAttemptsUsed;
                    if (attemptIx >= MAX_SCRAPE_SESSION_RECOVERIES) {
                        result.errors.push(
                            `Session recovery abandoned after ${MAX_SCRAPE_SESSION_RECOVERIES} attempts (last: ${reason}).`
                        );
                        return false;
                    }
                    recoveryAttemptsUsed++;
                    const backoff =
                        SCRAPE_SESSION_RECOVERY_BACKOFF_MS[attemptIx] ??
                        SCRAPE_SESSION_RECOVERY_BACKOFF_MS[SCRAPE_SESSION_RECOVERY_BACKOFF_MS.length - 1];
                    /** @type {{ attempt: number, reason: string, atPagerPage: number|null, at: string, succeeded: boolean, error?: string }} */
                    const evt = {
                        attempt: attemptIx + 1,
                        reason: String(reason),
                        atPagerPage: lastCompletedPagerPage,
                        at: new Date().toISOString(),
                        succeeded: false
                    };
                    recoveryEvents.push(evt);

                    console.warn(
                        `[packages] session lost (${reason}), recovering ${evt.attempt}/${MAX_SCRAPE_SESSION_RECOVERIES}, wait ${backoff}ms`
                    );
                    await delay(backoff);

                    try {
                        await loginAndOpenWorksheet(page, primary, backup, username, password);
                        result.filtersApplied = await applyFilters(page, filters);
                        if (filters.bu && result.filtersApplied && result.filtersApplied.businessUnit) {
                            const rs = await readBuState(page);
                            buCanarySelectValue = rs.exists ? rs.value : null;
                        } else {
                            buCanarySelectValue = null;
                        }

                        const searchedR = await clickSearch(page);
                        if (!searchedR) result.errors.push('Recovery: Search click did not find a control');
                        await waitForSampleGrid(page);

                        const resumeAt = lastCompletedPagerPage != null ? lastCompletedPagerPage + 1 : 1;
                        if (resumeAt > 1) {
                            const jumped = await jumpToSampleGridPage(page, resumeAt, gridOpts);
                            if (!jumped) {
                                result.errors.push(
                                    `Recovery: unable to navigate to worksheet pager page ${resumeAt} (still on worksheet).`
                                );
                            }
                        }

                        evt.succeeded = true;
                        console.log('[packages] session recovery completed');
                        return true;
                    } catch (recErr) {
                        evt.error = String(recErr && recErr.message ? recErr.message : recErr);
                        result.errors.push(`Recovery attempt failed: ${evt.error}`);
                        return false;
                    }
                }

                while (pagesScanned < HARD_SCRAPE_PAGE_LIMIT && hasMorePages) {
                    try {
                        const snap = await verifyWorksheetSession(page, { expectedBuSelectValue: buCanarySelectValue });
                        if (!snap.ok) {
                            const verr =
                                /** @type {Error & { __sessionLost?: boolean, __recoveryReason?: string }} */ (
                                    new Error(snap.reason)
                                );
                            verr.__sessionLost = true;
                            verr.__recoveryReason = snap.reason;
                            throw verr;
                        }

                        const pagerInfo = await guardedEvaluateChain(page, () => getSampleGridPagerInfo(page));
                        const chunk = await guardedEvaluateChain(page, () => scrapeSampleRowsWithTestNames(page, gridOpts));

                        const pp = pagerInfo.found && pagerInfo.currentPage != null ? pagerInfo.currentPage : null;
                        if (pp != null && completedPagerPages.has(pp)) {
                            console.warn(`[packages] pager page ${pp} seen before — skipping row append`);
                        } else {
                            rowsAll.push(...chunk);
                            if (pp != null) completedPagerPages.add(pp);
                        }

                        pagesScanned++;
                        pageVisits.push({
                            index: pagesScanned,
                            pagerPage: pp,
                            rowCount: chunk.length,
                            rowsWithBracketLabels: countRowsWithBracketLabels(chunk)
                        });

                        if (pp != null) lastCompletedPagerPage = pp;

                        try {
                            if (pagesScanned > 0 && pagesScanned % 10 === 0) {
                                writeRunFile(pkgFile, scrapePayloadPartial(), orgId);
                                outPackagesPath = pkgFile;
                                result.scrapePackages.packagesJsonPath = pkgFile;
                            }
                        } catch (wf) {
                            result.errors.push(`partial packages save: ${wf.message}`);
                        }

                        const nextRes = await guardedEvaluateChain(page, () =>
                            goToNextSampleGridPage(page, gridOpts)
                        );
                        hasMorePages = !!nextRes.moved;
                    } catch (e) {
                        const eo =
                            e && typeof e === 'object'
                                ? /** @type {{ __sessionLost?: boolean, message?: string, __recoveryReason?: string }} */ (
                                      e
                                  )
                                : {};
                        const msg = String(eo && eo.message !== undefined ? eo.message : e);
                        const lost = !!eo.__sessionLost || isSessionEvaluateDestroyed(msg);
                        if (!lost) throw e;

                        const reason =
                            eo && typeof eo.__recoveryReason === 'string' ? eo.__recoveryReason : msg;

                        const recovered = await recoverWorksheetSession(reason);
                        if (!recovered) {
                            hasMorePages = false;
                            break;
                        }
                    }
                }

                if (pagesScanned >= HARD_SCRAPE_PAGE_LIMIT && hasMorePages) {
                    const msg = `Package scrape hit internal page limit (${HARD_SCRAPE_PAGE_LIMIT}); results may be incomplete.`;
                    console.warn(msg);
                    result.errors.push(msg);
                }

                const agg = aggregateRows(rowsAll);
                const packagesPayload = {
                    startedAt,
                    filter: { ...filters },
                    filtersApplied: result.filtersApplied,
                    pagesScanned,
                    pageVisits,
                    rowCount: rowsAll.length,
                    uniqueLabelCount: agg.uniqueLabelCount,
                    labelToSids: agg.labelToSids,
                    labelOccurrences: agg.labelOccurrences,
                    otherTestsRowCount: agg.otherTestsRowCount,
                    recoveryEvents,
                    completedPagerPages: [...completedPagerPages].sort((a, b) => a - b),
                    lastCompletedPagerPage,
                    partial: false
                };
                result.scrapePackages = {
                    enabled: true,
                    pagesScanned,
                    pageVisits,
                    rowCount: rowsAll.length,
                    uniqueLabelCount: agg.uniqueLabelCount,
                    packagesJsonPath: null,
                    labelOccurrences: agg.labelOccurrences,
                    otherTestsRowCount: agg.otherTestsRowCount,
                    recoveryEvents,
                    completedPagerPages: packagesPayload.completedPagerPages,
                    lastCompletedPagerPage
                };

                writeRunFile(pkgFile, packagesPayload, orgId);
                outPackagesPath = pkgFile;
                result.scrapePackages.packagesJsonPath = pkgFile;
                console.log(`Wrote ${pkgFile}`);
                console.log(
                    `Package scrape: ${pagesScanned} page(s), ${rowsAll.length} row(s), ${agg.uniqueLabelCount} unique label(s), ${agg.otherTestsRowCount} Other tests cell(s), ${recoveryEvents.length} session recover(ies).`
                );
                const labelsSorted = Object.keys(agg.labelOccurrences).sort();
                console.log('label\toccurrences');
                for (const lab of labelsSorted) {
                    console.log(`${lab}\t${agg.labelOccurrences[lab]}`);
                }
            } else {
                const sids = await listSidsForCurrentPage(page, { skipRegionalBadge: skipRegional });
                result.sidsFoundOnPage1 = [...sids];

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
        }

        fs.mkdirSync(outDir, { recursive: true });
        const outFile = path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}.json`);
        writeRunFile(outFile, result, orgId);
        outMainPath = outFile;
        console.log(`Wrote ${outFile}`);
        console.log(`SIDs (page 1, ${result.sidsFoundOnPage1.length}): ${JSON.stringify(result.sidsFoundOnPage1)}`);
    } catch (e) {
        exitCode = 1;
        result.errors.push(String(e && e.message ? e.message : e));
        console.error(e);
        try {
            fs.mkdirSync(outDir, { recursive: true });
            const outFile = path.join(outDir, `run-${startedAt.replace(/[:.]/g, '-')}-error.json`);
            writeRunFile(outFile, result, orgId);
            outMainPath = outFile;
        } catch (_) {}
    } finally {
        if (browser) {
            await browser.close().catch(() => {});
        }
    }

    return { result, outMainPath, outPackagesPath, exitCode };
}

module.exports = {
    runLisNavBot,
    assertReadOnlyAllowed,
    pickStr,
    pickNum,
    resolveUrls,
    resolveCredentials
};
