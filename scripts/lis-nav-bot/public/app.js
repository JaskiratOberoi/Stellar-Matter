(function () {
    const LS_VIEW = 'lisbot:view';
    const LS_SIDEBAR = 'lisbot:sidebar';

    const form = document.getElementById('run-form');
    const submitBtn = document.getElementById('submit-btn');
    const clearBtn = document.getElementById('clear-btn');
    const runStatus = document.getElementById('run-status');
    const latestStatusPill = document.getElementById('latest-status-pill');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const appShell = document.getElementById('app-shell');
    const runSidebar = document.getElementById('run-sidebar');

    const resultsPlaceholder = document.getElementById('results-placeholder');
    const resultsBody = document.getElementById('results-body');
    const runningShade = document.getElementById('running-shade');
    const lastUpdatedEl = document.getElementById('last-updated');
    const viewResults = document.getElementById('view-results');
    const viewHistory = document.getElementById('view-history');
    const tabResultsBtn = document.getElementById('tab-results');
    const tabHistoryBtn = document.getElementById('tab-history');

    const packageMetricsZone = document.getElementById('package-metrics');
    const nonPackageBanner = document.getElementById('non-package-banner');
    const nonPackageMode = document.getElementById('non-package-mode');
    const nonPackageStats = document.getElementById('non-package-stats');

    const kpiTotalPages = document.getElementById('kpi-total-pages');
    const kpiTotalSub = document.getElementById('kpi-total-pages-sub');
    const kpiEstChip = document.getElementById('kpi-estimated-chip');
    const kpiOccurrences = document.getElementById('kpi-occurrences');
    const kpiUnique = document.getElementById('kpi-unique');
    const kpiPagesScanned = document.getElementById('kpi-pages-scanned');
    const kpiRecoveries = document.getElementById('kpi-recoveries');
    const kpiErrors = document.getElementById('kpi-errors');

    const heroCalloutLabel = document.getElementById('hero-callout-label');
    const heroCalloutSub = document.getElementById('hero-callout-sub');
    const heroCalloutPages = document.getElementById('hero-callout-pages');

    const filtersAppliedLine = document.getElementById('filters-applied-line');
    const runMetaStrip = document.getElementById('run-meta-strip');
    const recoveryDrawer = document.getElementById('recovery-drawer');
    const recoveryBody = document.getElementById('recovery-body');

    const packagesSection = document.getElementById('packages-section');
    const packagesTableWrap = document.getElementById('packages-table-wrap');
    const packagesStats = document.getElementById('packages-stats');
    const packagesShown = document.getElementById('packages-shown');
    const packagesSearch = document.getElementById('packages-search');
    const historyTable = document.querySelector('#history-table tbody');
    const historyPath = document.getElementById('history-path');
    const refreshHistory = document.getElementById('refresh-history');
    const detailJson = document.getElementById('detail-json');
    const detailPackagesWrap = document.getElementById('detail-packages-table-wrap');
    const scrapePackages = document.getElementById('scrapePackages');
    const openSid = document.getElementById('openSid');

    let activeTab = 'main';
    let pollTimer = null;
    let selectedId = null;
    let lastLatestPackageRows = [];
    /** @type {ReturnType<typeof makeOtherTestsPinned>|null} */
    let lastLatestPinned = null;
    /** @type {any} */
    let lastDashboardPayload = null;

    /** @type {'results'|'history'} */
    let currentView =
        typeof localStorage !== 'undefined' && localStorage.getItem(LS_VIEW) === 'history' ? 'history' : 'results';

    let pendingFocusResults = false;

    /**
     * @param {{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null, isOther?: boolean }[]} bodyRows
     * @param {{ label: string, count: number, pagesPerReport?: number|null, isOther?: boolean }|null} pinnedRow
     * @returns {{ knownSum: number, unknownLabels: number }}
     */
    function aggregateWholeScanPrintedPagesFromRows(bodyRows, pinnedRow) {
        let knownSum = 0;
        let unknownLabels = 0;
        /** @param {{ label?: string, count?: number, isOther?: boolean, pagesPerReport?: number|null, totalPages?: number|null }} row */
        const add = (row) => {
            const p = resolveTotalPagesProduct(row);
            if (p == null) unknownLabels++;
            else knownSum += p;
        };
        if (pinnedRow && Number(pinnedRow.count) > 0) add(pinnedRow);
        (bodyRows || []).forEach(add);
        return { knownSum, unknownLabels };
    }

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function syncOpenSidDisabled() {
        const dis = scrapePackages.checked;
        if (openSid) {
            openSid.disabled = dis;
            if (dis) openSid.value = '';
        }
    }

    scrapePackages?.addEventListener('change', syncOpenSidDisabled);
    syncOpenSidDisabled();

    function setView(which) {
        currentView = which === 'history' ? 'history' : 'results';
        try {
            localStorage.setItem(LS_VIEW, currentView);
        } catch {
            /**/
        }

        const isResults = currentView === 'results';

        if (tabResultsBtn) tabResultsBtn.setAttribute('aria-selected', isResults ? 'true' : 'false');
        if (tabHistoryBtn) tabHistoryBtn.setAttribute('aria-selected', isResults ? 'false' : 'true');

        tabResultsBtn?.classList.toggle('active', isResults);
        tabHistoryBtn?.classList.toggle('active', !isResults);

        if (viewResults) viewResults.hidden = !isResults;
        if (viewHistory) viewHistory.hidden = isResults;
    }

    function getSidebarCollapsedStored() {
        try {
            return localStorage.getItem(LS_SIDEBAR) === '1';
        } catch {
            return false;
        }
    }

    function setSidebarCollapsed(collapsed) {
        appShell?.classList.toggle('sidebar-collapsed', collapsed);
        runSidebar?.classList.toggle('collapsed-visual', collapsed);
        if (sidebarToggle) {
            sidebarToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
            sidebarToggle.title = collapsed ? 'Expand run panel' : 'Collapse run panel';
        }
        try {
            localStorage.setItem(LS_SIDEBAR, collapsed ? '1' : '0');
        } catch {
            /**/
        }
    }

    if (sidebarToggle && appShell) {
        sidebarToggle.addEventListener('click', () => {
            const willCollapse = !appShell.classList.contains('sidebar-collapsed');
            setSidebarCollapsed(willCollapse);
        });
    }

    setSidebarCollapsed(getSidebarCollapsedStored());
    tabResultsBtn?.addEventListener('click', () => setView('results'));
    tabHistoryBtn?.addEventListener('click', () => setView('history'));
    setView(currentView);

    function setupDetailTabs() {
        document.querySelectorAll('#view-history .tabs button.tab[data-tab]').forEach((btn) => {
            btn.addEventListener('click', () => {
                document.querySelectorAll('#view-history .tabs button.tab').forEach((b) => {
                    b.classList.remove('active');
                    b.setAttribute('aria-selected', 'false');
                });
                btn.classList.add('active');
                btn.setAttribute('aria-selected', 'true');
                activeTab = btn.getAttribute('data-tab') || 'main';
                renderDetailPlaceholder();
                if (selectedId) loadDetail(selectedId);
            });
        });
    }

    setupDetailTabs();

    form?.addEventListener('keydown', (e) => {
        if (
            !e.repeat &&
            (e.key === 'Enter' || e.code === 'Enter') &&
            (e.ctrlKey || e.metaKey) &&
            !(/** @type {HTMLElement} */ (e.target)?.closest?.('[contenteditable=true]'))
        ) {
            e.preventDefault();
            if (!(/** @type {HTMLButtonElement} */ (submitBtn))?.disabled) form.requestSubmit();
        }
    });

    (function setupViewShortcuts() {
        /** @type {ReturnType<typeof setTimeout>|null} */
        let clearT = null;
        let awaitingSecond = false;
        window.addEventListener(
            'keydown',
            /** @param {KeyboardEvent} e */
            (e) => {
                const ae = /** @type {HTMLElement|null} */ (document.activeElement);
                const tn = ae && ae.tagName;
                if (tn === 'INPUT' || tn === 'TEXTAREA' || tn === 'SELECT') return;

                const ch = typeof e.key === 'string' && e.key.length === 1 ? e.key.toLowerCase() : '';

                if (ch === 'g') {
                    if (clearT) clearTimeout(clearT);
                    awaitingSecond = true;
                    clearT = setTimeout(() => {
                        awaitingSecond = false;
                        clearT = null;
                    }, 950);
                    return;
                }

                if (!awaitingSecond) return;
                if (ch !== 'r' && ch !== 'h') return;

                e.preventDefault();
                awaitingSecond = false;
                if (clearT) clearTimeout(clearT);
                clearT = null;
                setView(ch === 'r' ? 'results' : 'history');
            },
            true
        );
    })();

    /** @param {string} s */
    function normalizePackageLabel(s) {
        return String(s || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** @type {Record<string, number>} */
    let clientPagesByNorm = {};

    /** @returns {Promise<void>} */
    function loadPackagePagesMap() {
        return fetch('/api/package-pages')
            .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
            .then((j) => {
                clientPagesByNorm = {};
                for (const [k, v] of Object.entries(j.pages || {})) {
                    const n = Number(v);
                    if (!Number.isFinite(n)) continue;
                    clientPagesByNorm[normalizePackageLabel(k)] = n;
                }
            })
            .catch(() => {
                clientPagesByNorm = {};
            });
    }

    /**
     * @param {{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null }} row
     * @returns {number|null}
     */
    function resolvePagesPerReport(row) {
        if (row.isOther === true) return 1;
        if (row.pagesPerReport != null && Number.isFinite(Number(row.pagesPerReport))) return Number(row.pagesPerReport);
        if (row.totalPages != null && Number.isFinite(Number(row.totalPages))) return Number(row.totalPages);
        const n = clientPagesByNorm[normalizePackageLabel(row.label)];
        return Number.isFinite(n) ? n : null;
    }

    /**
     * @param {{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null, isOther?: boolean }} row
     * @returns {number|null}
     */
    function resolveTotalPagesProduct(row) {
        const ppr = resolvePagesPerReport(row);
        if (ppr == null) return null;
        const c = Number(row.count) || 0;
        return c * ppr;
    }

    /** @param {Record<string, number>|null|undefined} occ */
    function rowsFromLabelOccurrences(occ) {
        if (!occ || typeof occ !== 'object') return [];
        return Object.entries(occ).map(([label, count]) => ({ label, count: Number(count) || 0 }));
    }

    /** @returns {{ label: string, count: number, pagesPerReport: number, isOther: true }|null} */
    function makeOtherTestsPinned(count) {
        const n = Math.floor(Number(count)) || 0;
        if (n < 1) return null;
        return { label: 'Other tests', count: n, pagesPerReport: 1, isOther: /** @type {const} */ (true) };
    }

    /**
     * @param {*} summary
     * @param {*} result
     * @returns {{ packageRows: Array<{ label: string, count: number }>, pinned: ReturnType<typeof makeOtherTestsPinned>, isScrape: boolean }}
     */
    function buildPackageDataset(summary, result) {
        const isScrape = !!(summary && summary.scrapePackages);
        /** @type {Array<{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null }>} */
        let packageRows = [];
        if (summary && Array.isArray(summary.packageLabelRows)) {
            packageRows = summary.packageLabelRows.slice();
        } else {
            packageRows = rowsFromLabelOccurrences(
                result && result.scrapePackages && result.scrapePackages.labelOccurrences
            );
        }
        const otherN =
            (summary && typeof summary.otherTestsRowCount === 'number' && Number.isFinite(summary.otherTestsRowCount)
                ? summary.otherTestsRowCount
                : null) ??
            (result &&
            result.scrapePackages &&
            typeof result.scrapePackages.otherTestsRowCount === 'number' &&
            Number.isFinite(result.scrapePackages.otherTestsRowCount)
                ? result.scrapePackages.otherTestsRowCount
                : 0);
        const pinned = makeOtherTestsPinned(otherN);
        return { packageRows, pinned, isScrape };
    }

    /** Stateful table — sort + filter; footer uses shared totals helper */
    /** @param {HTMLElement|null} host */
    function createPackagesTable(host) {
        if (!host)
            return {
                /** @returns {void} */
                setRows() {},
                /** @returns {void} */ setFilter() {},
                redraw() {},
                /** @returns {{ total: number, unique: number }} */ getStats: () => ({ total: 0, unique: 0 })
            };

        const state = /** @type {any} */ ({
            rows: /** @type {Array<{ label: string, count: number }>} */ ([]),
            pinned: /** @type {ReturnType<typeof makeOtherTestsPinned>} */ (null),
            sortKey: 'count',
            sortDir: 'desc',
            filter: '',
            onCount: /** @type {((visible: number, total: number) => void)|null} */ (null)
        });

        function filtered() {
            const q = state.filter.trim().toLowerCase();
            const rs = q ? state.rows.filter((/** @type {*} */ r) => r.label.toLowerCase().includes(q)) : state.rows.slice();
            const k = state.sortKey;
            const dir = state.sortDir === 'asc' ? 1 : -1;
            const ascend = state.sortDir === 'asc';
            rs.sort((a, b) => {
                if (k === 'label') return dir * a.label.localeCompare(b.label);
                if (k === 'count') return dir * (a.count - b.count);
                if (k === 'pages') {
                    const pa = resolveTotalPagesProduct(a);
                    const pb = resolveTotalPagesProduct(b);
                    const va = pa != null ? pa : ascend ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
                    const vb = pb != null ? pb : ascend ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
                    return dir * (va - vb);
                }
                return 0;
            });
            return rs;
        }

        function header(key, label, extraClass) {
            const cls = ['sortable'];
            if (state.sortKey === key) cls.push('sorted');
            if (extraClass) cls.push(extraClass);
            const arrow = state.sortKey === key ? (state.sortDir === 'asc' ? '▲' : '▼') : '';
            return `<th class="${cls.join(' ')}" data-key="${key}">${escapeHtml(label)}<span class="sort-arrow">${arrow}</span></th>`;
        }

        function render() {
            const sortedBodyRows = filtered();
            const pinnedRow = state.pinned && Number(state.pinned.count) > 0 ? state.pinned : null;
            const hasPinned = !!pinnedRow;
            const visibleCount = sortedBodyRows.length + (hasPinned ? 1 : 0);
            const totalRowSlots = state.rows.length + (hasPinned ? 1 : 0);
            if (state.onCount) state.onCount(visibleCount, totalRowSlots);

            if (!state.rows.length && !hasPinned) {
                host.innerHTML = '<div class="empty">No package labels in scrape results.</div>';
                return;
            }
            if (!sortedBodyRows.length && !hasPinned) {
                host.innerHTML = '<div class="empty">No labels match this filter.</div>';
                return;
            }

            const rank1Candidate =
                sortedBodyRows.length &&
                state.sortKey === 'count' &&
                state.sortDir === 'desc' &&
                !state.filter.trim()
                    ? sortedBodyRows[0]
                    : null;

            let html =
                '<table class="packages"><thead><tr>' +
                '<th>#</th>' +
                header('label', 'Package label') +
                header('count', 'Count', 'count') +
                header('pages', 'Total Pages', 'pages') +
                '</tr></thead><tbody>';

            if (pinnedRow) {
                const totalPagesProduct = resolveTotalPagesProduct(pinnedRow);
                const pagesCell =
                    totalPagesProduct != null
                        ? `<td class="pages-num">${escapeHtml(String(totalPagesProduct.toLocaleString('en-US')))}</td>`
                        : '<td class="pages-cell"><span class="unknown-chip">unknown</span></td>';
                html +=
                    `<tr class="pinned-row">` +
                    `<td class="rank rank-pinned">—</td>` +
                    `<td class="label">${escapeHtml(pinnedRow.label)}</td>` +
                    `<td class="count">${escapeHtml(String(pinnedRow.count))}</td>` +
                    pagesCell +
                    '</tr>';
            }

            sortedBodyRows.forEach((row, i) => {
                const trClass = rank1Candidate && row === rank1Candidate ? 'rank-1' : '';
                const totalPagesProduct = resolveTotalPagesProduct(row);
                const pagesCell =
                    totalPagesProduct != null
                        ? `<td class="pages-num">${escapeHtml(String(totalPagesProduct.toLocaleString('en-US')))}</td>`
                        : '<td class="pages-cell"><span class="unknown-chip">unknown</span></td>';
                html +=
                    `<tr class="${trClass}">` +
                    `<td class="rank">${i + 1}</td>` +
                    `<td class="label">${escapeHtml(row.label)}</td>` +
                    `<td class="count">${escapeHtml(String(row.count))}</td>` +
                    pagesCell +
                    '</tr>';
            });

            const { knownSum, unknownLabels } = aggregateWholeScanPrintedPagesFromRows(
                state.rows,
                hasPinned ? pinnedRow : null
            );

            const totalPagesCellNum = knownSum.toLocaleString('en-US');
            const totalPagesCellBody =
                unknownLabels === 0
                    ? escapeHtml(totalPagesCellNum)
                    : `${escapeHtml(totalPagesCellNum)} <span class="muted">${escapeHtml(
                          ` (${unknownLabels} label${unknownLabels === 1 ? '' : 's'} unmapped — minimum)`
                      )}</span>`;

            const tfootPagesCls = `pages-num packages-tfoot-pages${unknownLabels > 0 ? ' estimated-sum' : ''}`;

            html +=
                '</tbody>' +
                '<tfoot>' +
                '<tr class="packages-tfoot-row">' +
                `<td colspan="3" class="packages-tfoot-label">${escapeHtml('Total printed pages · whole scan')}</td>` +
                `<td class="${tfootPagesCls}">${totalPagesCellBody}${
                    unknownLabels > 0 ? ' <span class="muted estimated-chip-inline">estimated</span>' : ''
                }</td>` +
                '</tr>' +
                '</tfoot>' +
                '</table>';
            host.innerHTML = html;

            host.querySelectorAll('th.sortable').forEach((th) => {
                th.addEventListener('click', () => {
                    const k = th.getAttribute('data-key');
                    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                    else {
                        state.sortKey = k || 'label';
                        state.sortDir = k === 'label' ? 'asc' : 'desc';
                    }
                    render();
                });
            });
        }

        return {
            /** @type {(rows: any[], opts?: object) => void} */
            setRows(rows, opts = {}) {
                state.rows = rows.slice();
                state.pinned = opts.pinned && opts.pinned.isOther && Number(opts.pinned.count) > 0 ? opts.pinned : null;
                if (opts.onCount) state.onCount = opts.onCount;
                state.sortKey = 'count';
                state.sortDir = 'desc';
                state.rows.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
                render();
            },
            setFilter(q) {
                state.filter = String(q || '');
                render();
            },
            getStats() {
                return {
                    total: state.rows.reduce((s, /** @type {*} */ r) => s + r.count, 0) + (state.pinned ? state.pinned.count : 0),
                    unique: state.rows.length + (state.pinned ? 1 : 0)
                };
            },
            redraw() {
                render();
            }
        };
    }

    const latestPackagesTable = packagesTableWrap ? createPackagesTable(packagesTableWrap) : null;
    const detailPackagesTable = detailPackagesWrap ? createPackagesTable(detailPackagesWrap) : null;

    if (packagesSearch && latestPackagesTable) {
        packagesSearch.addEventListener('input', (e) => latestPackagesTable.setFilter(/** @type {*} */ (e.target).value));
    }

    /** @param {typeof lastLatestPackageRows} rows */
    /** @param {ReturnType<typeof makeOtherTestsPinned>} pinned */
    function renderPackagesStats(rows, pinned) {
        if (!packagesStats) return;
        let total = rows.reduce((s, r) => s + r.count, 0);
        if (pinned && pinned.count > 0) total += pinned.count;
        const unknownN = rows.filter((r) => !r.isOther && resolvePagesPerReport(r) == null).length;
        const parts = [
            `<span class="stat-pill"><span>Unique labels</span><strong>${rows.length}</strong></span>`,
            `<span class="stat-pill"><span>Total occurrences</span><strong>${total}</strong></span>`
        ];
        if (unknownN > 0) {
            parts.push(
                `<span class="stat-pill stat-pill-info"><span>Unmapped</span><strong>${unknownN}</strong></span>`
            );
        }
        packagesStats.innerHTML = parts.join('');
    }

    function setShownCount(visible, total) {
        if (!packagesShown) return;
        packagesShown.textContent =
            visible === total ? `${total} label${total === 1 ? '' : 's'}` : `${visible} of ${total} labels`;
    }

    function setStatusPill(kind, text) {
        if (!latestStatusPill) return;
        if (!kind) {
            latestStatusPill.hidden = true;
            return;
        }
        latestStatusPill.hidden = false;
        latestStatusPill.className = `status-pill ${kind}`;
        latestStatusPill.textContent = text;
    }

    function bumpLastUpdated() {
        if (lastUpdatedEl) lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
    }

    function fmtPath(p) {
        if (!p) return `<span class="muted">—</span>`;
        return `<span class="path">${escapeHtml(String(p))}</span>`;
    }

    function modeLabel(summary) {
        if (!summary) return '—';
        if (summary.dryRun) return 'dry-run';
        if (summary.scrapePackages) return 'package scrape';
        return 'normal search';
    }

    /** @param {*} summary */
    function scrapeOccurrences(summary) {
        const n =
            summary && summary.rowCount != null && Number.isFinite(Number(summary.rowCount))
                ? Number(summary.rowCount)
                : 0;
        return Math.max(0, Math.floor(n));
    }

    /** @param {Array<{label:string,count:number}>} packageRows */
    function heroFromRows(packageRows, pinned) {
        if (!heroCalloutLabel || !heroCalloutPages) return;

        /** @type {(typeof packageRows)[0]|null} */
        let star = null;
        for (const row of packageRows || []) {
            if (!star || Number(row.count) > Number(star.count)) star = row;
        }

        if (!star) {
            heroCalloutLabel.innerHTML =
                pinned && pinned.count > 0
                    ? `Only bracket-less “${escapeHtml(pinned.label)}” cells detected this run (${escapeHtml(
                          String(pinned.count)
                      )}).`
                    : 'No labelled packages in scrape output.';
            if (heroCalloutSub) heroCalloutSub.textContent = pinned ? `${pinned.count} cells × 1 page each` : '';
            heroCalloutPages.textContent = pinned ? String(pinned.count * 1) : '—';
            return;
        }

        heroCalloutLabel.textContent = star.label;

        const ppr = resolvePagesPerReport(star);
        const tp = resolveTotalPagesProduct(star);
        heroCalloutSub.textContent =
            ppr != null
                ? `${Number(star.count).toLocaleString('en-US')} occurrence(s) × ${ppr.toLocaleString('en-US')} page(s)/print`
                : 'Pages per printed report unknown for this label — map it in package-pages.json.';

        heroCalloutPages.textContent = tp != null ? tp.toLocaleString('en-US') : '—';
    }

    /**
     * @param {*} summary
     * @param {*} j - status payload fragment
     */
    function populateRecoveryDrawer(summary) {
        if (!recoveryDrawer || !recoveryBody) return;

        const rc = Number(summary && summary.recoveryCount) || 0;
        const rev =
            summary && summary.recoveryEvents && Array.isArray(summary.recoveryEvents) ? summary.recoveryEvents : [];
        recoveryDrawer.hidden = rc < 1;
        recoveryBody.textContent =
            rc < 1
                ? ''
                : rev.length
                  ? rev
                        .map(
                            /** @type {*} */
                            (ev) =>
                                `#${ev.attempt} ${ev.succeeded ? 'ok' : 'fail'} pager=${ev.atPagerPage ?? '—'} — ${ev.reason}${ev.error ? ` err=${ev.error}` : ''} @ ${ev.at || ''}`
                        )
                        .join('\n')
                  : String(rc);

        recoveryDrawer.open = false;
    }

    /**
     * @param {*} summary
     * @param {*} j
     */
    function renderRunMetaStrip(summary, j) {
        if (!runMetaStrip) return;

        const errCount = Array.isArray(summary && summary.errors) ? summary.errors.length : 0;
        const errCell =
            errCount === 0
                ? escapeHtml('0')
                : `<span class="errors-cell">${escapeHtml(summary.errors.join('\n'))}</span>`;

        const exit =
            j && j.exitCode === 0
                ? '<span class="status-pill ok">success</span>'
                : `<span class="status-pill err">exit ${escapeHtml(String(j && j.exitCode))}</span>`;

        const parts = [
            `<dl><dt>Status</dt><dd>${exit}</dd></dl>`,
            j && j.error
                ? `<dl><dt>Request</dt><dd class="errors-cell">${escapeHtml(String(j.error))}</dd></dl>`
                : '',
            `<dl><dt>Run id</dt><dd>${j && j.runId ? `<code>${escapeHtml(String(j.runId))}</code>` : '—'}</dd></dl>`,
            `<dl><dt>Started</dt><dd>${summary && summary.startedAt ? escapeHtml(String(summary.startedAt)) : '—'}</dd></dl>`,
            `<dl><dt>Mode</dt><dd>${escapeHtml(modeLabel(summary))}</dd></dl>`,
            `<dl><dt>Main JSON</dt><dd>${fmtPath((j && j.outMainPath) || (summary && summary.outMainPath))}</dd></dl>`,
            summary && (summary.scrapePackages || (j && j.outPackagesPath))
                ? `<dl><dt>Packages JSON</dt><dd>${fmtPath((j && j.outPackagesPath) || (summary && summary.outPackagesPath))}</dd></dl>`
                : '',
            `<dl><dt>Errors</dt><dd>${errCell}</dd></dl>`
        ];

        runMetaStrip.innerHTML = parts.filter(Boolean).join('');
    }

    /**
     * @param {*} summary
     * @param {*} result
     * @param {*} j
     */
    function renderPackageKpis(summary, result) {
        const { packageRows, pinned } = buildPackageDataset(summary, result);
        const agg = aggregateWholeScanPrintedPagesFromRows(packageRows, pinned);

        const occ = scrapeOccurrences(summary);
        const uniq =
            summary && summary.uniqueLabelCount != null && Number.isFinite(Number(summary.uniqueLabelCount))
                ? Number(summary.uniqueLabelCount)
                : packageRows.length;

        if (kpiTotalPages) kpiTotalPages.textContent = agg.knownSum.toLocaleString('en-US');
        if (kpiTotalSub) {
            kpiTotalSub.textContent =
                agg.unknownLabels > 0
                    ? `Minimum until ${agg.unknownLabels} label${agg.unknownLabels === 1 ? '' : 's'} have pages/report mapping`
                    : 'Sum of (count × pages per report) + Other tests';
        }
        if (kpiEstChip) kpiEstChip.hidden = agg.unknownLabels === 0;

        if (kpiOccurrences) kpiOccurrences.textContent = occ.toLocaleString('en-US');
        if (kpiUnique) kpiUnique.textContent = uniq.toLocaleString('en-US');
        if (kpiPagesScanned) {
            kpiPagesScanned.textContent =
                summary && summary.pagesScanned != null && Number.isFinite(Number(summary.pagesScanned))
                    ? String(summary.pagesScanned)
                    : '—';
        }
        if (kpiRecoveries) {
            kpiRecoveries.textContent =
                summary && summary.recoveryCount != null ? String(summary.recoveryCount) : '0';
        }
        if (kpiErrors) {
            const ec = Array.isArray(summary && summary.errors) ? summary.errors.length : 0;
            kpiErrors.textContent = String(ec);
        }

        heroFromRows(packageRows, pinned);
        populateRecoveryDrawer(summary);
    }

    /**
     * @param {*} j
     * @param {{ fromRefresh?: boolean }} [opts]
     */
    function renderResultsDashboard(j, opts = {}) {
        const summary = (j && j.summary) || {};
        const result = (j && j.result) || null;

        if (resultsPlaceholder) resultsPlaceholder.hidden = true;
        if (resultsBody) resultsBody.hidden = false;

        bumpLastUpdated();

        if (resultsBody) {
            resultsBody.classList.remove('dashboard-state-running');
            if (runningShade) runningShade.hidden = true;
        }

        if (filtersAppliedLine) {
            const req = (result && result.filtersRequested) || {};
            const app = (result && result.filtersApplied) || {};
            const parts = [];
            if (req.bu != null && String(req.bu).trim()) {
                if (app.businessUnit) parts.push(`BU: ${app.businessUnit}`);
                else parts.push(`BU not applied (“${String(req.bu).trim()}”)`);
            }
            if (req.status != null && String(req.status).trim()) {
                if (app.status) parts.push(`Status: ${app.status}`);
                else parts.push(`Status not applied (“${String(req.status).trim()}”)`);
            }
            if (req.testCode != null && String(req.testCode).trim() && !app.testCode) parts.push('Test code not applied');
            filtersAppliedLine.textContent = parts.length ? parts.join(' · ') : '';
        }

        renderRunMetaStrip(summary, j);

        const isScrape = !!summary.scrapePackages;

        if (packageMetricsZone) packageMetricsZone.hidden = !isScrape;
        if (nonPackageBanner) nonPackageBanner.hidden = isScrape;

        if (!isScrape && nonPackageMode && nonPackageStats) {
            nonPackageMode.textContent = modeLabel(summary);
            const sidN = summary.sidsOnPage1 != null ? Number(summary.sidsOnPage1) : 0;
            nonPackageStats.innerHTML = `Page-1 SIDs: <strong>${sidN.toLocaleString('en-US')}</strong> · exit <code>${escapeHtml(
                String(j && j.exitCode != null ? j.exitCode : '—')
            )}</code>`;
        }

        if (isScrape) renderPackageKpis(summary, result);
        if (recoveryDrawer && !isScrape) {
            recoveryDrawer.hidden = true;
            if (recoveryBody) recoveryBody.textContent = '';
        }

        if (!opts.fromRefresh) {
            if (pendingFocusResults && currentView === 'history') {
                setView('results');
            }
            pendingFocusResults = false;
        }
    }

    function showDashboardRunning() {
        if (resultsPlaceholder) resultsPlaceholder.hidden = true;
        if (resultsBody) {
            resultsBody.hidden = false;
            resultsBody.classList.add('dashboard-state-running');
        }
        if (runningShade) runningShade.hidden = false;

        if (packageMetricsZone) packageMetricsZone.hidden = false;
        if (nonPackageBanner) nonPackageBanner.hidden = true;

        const dash = ['—', '…', '···'];
        const ph = (/** @type {HTMLElement|null} */ el, i) => {
            if (el) el.textContent = dash[i % dash.length];
        };
        ph(kpiTotalPages, 0);
        ph(kpiOccurrences, 1);
        ph(kpiUnique, 2);
        ph(kpiPagesScanned, 0);
        ph(kpiRecoveries, 1);
        ph(kpiErrors, 2);
        if (kpiTotalSub) kpiTotalSub.textContent = 'Working…';
        if (kpiEstChip) kpiEstChip.hidden = true;
        if (heroCalloutLabel) heroCalloutLabel.textContent = 'Run in progress';
        if (heroCalloutSub) heroCalloutSub.textContent = '';
        if (heroCalloutPages) heroCalloutPages.textContent = '—';
        if (runMetaStrip) runMetaStrip.innerHTML = '';
        if (recoveryDrawer) recoveryDrawer.hidden = true;
        if (packagesSection) packagesSection.hidden = true;
    }

    /**
     * @param {*} summary
     * @param {*} result
     */
    function renderLatestPackages(summary, result) {
        if (!packagesSection || !latestPackagesTable) return;
        const { packageRows, pinned, isScrape } = buildPackageDataset(summary, result);
        lastLatestPackageRows = packageRows.slice();
        lastLatestPinned = pinned || null;

        if (!isScrape || (!packageRows.length && !pinned)) {
            packagesSection.hidden = true;
            lastLatestPackageRows = [];
            lastLatestPinned = null;
            return;
        }
        packagesSection.hidden = false;
        renderPackagesStats(packageRows, pinned);
        latestPackagesTable.setRows(packageRows, { onCount: setShownCount, pinned });
        if (packagesSearch) packagesSearch.value = '';
        latestPackagesTable.setFilter('');
    }

    function clearLatest() {
        setStatusPill(null);
        runStatus.textContent = '';
        if (filtersAppliedLine) filtersAppliedLine.textContent = '';
        pendingFocusResults = false;

        if (resultsPlaceholder) {
            resultsPlaceholder.hidden = false;
        }
        if (resultsBody) {
            resultsBody.hidden = true;
            resultsBody.classList.remove('dashboard-state-running');
        }
        if (runningShade) runningShade.hidden = true;

        if (packageMetricsZone) packageMetricsZone.hidden = false;

        kpiTotalPages && (kpiTotalPages.textContent = '—');
        kpiOccurrences && (kpiOccurrences.textContent = '—');
        kpiUnique && (kpiUnique.textContent = '—');
        kpiPagesScanned && (kpiPagesScanned.textContent = '—');
        kpiRecoveries && (kpiRecoveries.textContent = '—');
        kpiErrors && (kpiErrors.textContent = '—');
        if (kpiTotalSub) kpiTotalSub.textContent = '';
        if (kpiEstChip) kpiEstChip.hidden = true;
        heroCalloutLabel && (heroCalloutLabel.textContent = '—');
        heroCalloutSub && (heroCalloutSub.textContent = '');
        heroCalloutPages && (heroCalloutPages.textContent = '—');
        runMetaStrip && (runMetaStrip.innerHTML = '');
        if (recoveryDrawer) {
            recoveryDrawer.hidden = true;
            recoveryBody && (recoveryBody.textContent = '');
        }
        if (packagesSection) packagesSection.hidden = true;
        lastLatestPackageRows = [];
        lastLatestPinned = null;
        lastDashboardPayload = null;
    }

    clearBtn?.addEventListener('click', clearLatest);

    function formToBody() {
        const fd = new FormData(form);
        const body = {};
        for (const [k, v] of fd.entries()) {
            if (v === '') continue;
            body[k] = v;
        }
        body.scrapePackages = fd.has('scrapePackages');
        body.dryRun = fd.has('dryRun');
        body.headless = fd.has('headless');
        body.skipRegionalBadge = fd.has('skipRegionalBadge');
        body.noScreenshots = fd.has('noScreenshots');
        if (fd.has('fromHour')) body.fromHour = Number(body.fromHour);
        if (fd.has('toHour')) body.toHour = Number(body.toHour);
        return body;
    }

    /** @returns {Promise<boolean>} */
    async function pollUntilIdle() {
        const r = await fetch('/api/run/status');
        const j = await r.json();
        if (j.state === 'running') {
            runStatus.textContent = 'Running…';
            setStatusPill('running', 'running');
            showDashboardRunning();
            bumpLastUpdated();
            return false;
        }
        runStatus.textContent = j.exitCode === 0 ? 'Finished.' : 'Finished with errors.';
        setStatusPill(j.exitCode === 0 ? 'ok' : 'err', j.exitCode === 0 ? 'success' : 'error');

        renderLatestPackages(j.summary, j.result);
        renderResultsDashboard(j);
        lastDashboardPayload = j;
        if (submitBtn) submitBtn.disabled = false;
        loadHistory();
        return true;
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (submitBtn) submitBtn.disabled = true;
        runStatus.textContent = 'Starting…';
        setStatusPill('running', 'starting');
        pendingFocusResults = true;

        if (filtersAppliedLine) filtersAppliedLine.textContent = '';
        resultsPlaceholder.hidden = true;
        resultsBody.hidden = false;
        showDashboardRunning();

        if (packagesSection) packagesSection.hidden = true;
        try {
            const r = await fetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(formToBody())
            });
            const j = await r.json();
            if (r.status === 409) {
                runStatus.textContent = j.error || 'Busy';
                setStatusPill('err', 'busy');
                clearLatestPartial(j.error || 'Busy');
                if (submitBtn) submitBtn.disabled = false;
                return;
            }
            if (!r.ok) {
                runStatus.textContent = 'Error';
                setStatusPill('err', 'error');
                showErrorBanner(j.error ? String(j.error) : JSON.stringify(j, null, 2));
                if (submitBtn) submitBtn.disabled = false;
                return;
            }

            pollTimer = /** @type {any} */ (null);
            const doneNow = await pollUntilIdle();
            if (!doneNow) {
                pollTimer = setInterval(async () => {
                    if (await pollUntilIdle()) {
                        clearInterval(/** @type {*} */ (pollTimer));
                        pollTimer = null;
                    }
                }, 1500);
            }
        } catch (e) {
            runStatus.textContent = 'Request failed';
            setStatusPill('err', 'error');
            showErrorBanner(String(e));
            if (submitBtn) submitBtn.disabled = false;
        }
    });

    function clearLatestPartial(msg) {
        lastDashboardPayload = null;
        resultsPlaceholder.hidden = false;
        resultsBody.hidden = true;
        if (runningShade) runningShade.hidden = true;
        lastUpdatedEl && (lastUpdatedEl.textContent = msg);
    }

    function showErrorBanner(msg) {
        lastDashboardPayload = null;
        resultsPlaceholder.hidden = true;
        if (resultsBody) {
            resultsBody.hidden = false;
            resultsBody.classList.remove('dashboard-state-running');
        }
        if (runningShade) runningShade.hidden = true;
        if (packageMetricsZone) packageMetricsZone.hidden = true;
        if (packagesSection) packagesSection.hidden = true;
        if (nonPackageBanner) {
            nonPackageBanner.hidden = false;
            if (nonPackageMode) nonPackageMode.textContent = 'Error';
            if (nonPackageStats) nonPackageStats.innerHTML = `<span class="errors-cell">${escapeHtml(msg)}</span>`;
        }
    }

    async function loadHistory() {
        if (!historyTable) return;
        try {
            const r = await fetch('/api/runs');
            const j = await r.json();
            if (historyPath) historyPath.textContent = j.outDir ? `Scanning: ${j.outDir}` : '';
            historyTable.innerHTML = '';
            (j.runs || []).forEach((row) => {
                const tr = document.createElement('tr');
                tr.dataset.id = row.id;
                const p = row.preview || {};
                tr.innerHTML = [
                    `<td>${escapeHtml(row.mtime)}</td>`,
                    `<td>${escapeHtml(p.startedAt || '')}</td>`,
                    `<td>${p.scrapeEnabled ? 'scrape' : p.dryRun ? 'dry-run' : 'normal'}</td>`,
                    `<td>${p.pagesScanned != null ? `${p.pagesScanned} pg / ${p.rowCount ?? ''} rows` : '—'}</td>`,
                    `<td>${p.sidCount != null ? p.sidCount : '—'}</td>`
                ].join('');
                tr.addEventListener('click', () => {
                    historyTable.querySelectorAll('tr').forEach((t) => t.classList.remove('selected'));
                    tr.classList.add('selected');
                    selectedId = row.id;
                    loadDetail(row.id);
                });
                historyTable.appendChild(tr);
            });
        } catch (e) {
            historyTable.innerHTML = `<tr><td colspan="5">Failed to load history: ${escapeHtml(String(e))}</td></tr>`;
        }
    }

    function renderDetailPlaceholder() {
        if (!selectedId) {
            detailJson.textContent = '—';
            if (detailPackagesWrap) {
                detailPackagesWrap.hidden = true;
                detailPackagesWrap.innerHTML = '';
            }
            detailJson.hidden = false;
        }
    }

    /** @returns {Promise<void>} */
    async function loadDetail(id) {
        if (!id || !detailJson) return;
        try {
            const r = await fetch(`/api/runs/${encodeURIComponent(id)}`);
            const j = await r.json();
            if (!r.ok) {
                detailJson.hidden = false;
                if (detailPackagesWrap) detailPackagesWrap.hidden = true;
                detailJson.textContent = JSON.stringify(j, null, 2);
                return;
            }

            if (activeTab === 'table') {
                detailJson.hidden = true;
                if (detailPackagesWrap && detailPackagesTable) {
                    detailPackagesWrap.hidden = false;
                    const occ = j.packages && j.packages.labelOccurrences;
                    const rows = rowsFromLabelOccurrences(occ);
                    const otherN =
                        j.packages && typeof j.packages.otherTestsRowCount === 'number'
                            ? j.packages.otherTestsRowCount
                            : 0;
                    const pinned = makeOtherTestsPinned(otherN);
                    detailPackagesTable.setRows(rows, { pinned });
                }
                return;
            }

            detailJson.hidden = false;
            if (detailPackagesWrap) detailPackagesWrap.hidden = true;

            const payload =
                activeTab === 'packages' && j.packages
                    ? j.packages
                    : activeTab === 'packages' && !j.packages
                      ? { message: 'No packages file for this run' }
                      : j.main;
            detailJson.textContent = JSON.stringify(payload, null, 2);
        } catch (e) {
            detailJson.hidden = false;
            detailJson.textContent = String(e);
        }
    }

    /**
     * Restore Results dashboard after refresh when the server still holds the last idle job.
     * @returns {Promise<void>}
     */
    function hydrateFromLastJob() {
        return fetch('/api/run/status')
            .then((r) => r.json())
            .then((j) => {
                if (!j || j.state !== 'idle') return;
                const s = j.summary;
                if (!s || !s.startedAt) return;

                renderLatestPackages(s, j.result);
                renderResultsDashboard(j, { fromRefresh: true });
                lastDashboardPayload = j;
                if (runStatus) {
                    runStatus.textContent =
                        j.exitCode === 0 ? 'Finished.' : 'Finished with errors.';
                }
                if (typeof j.exitCode === 'number') {
                    setStatusPill(j.exitCode === 0 ? 'ok' : 'err', j.exitCode === 0 ? 'success' : 'error');
                }
            })
            .catch(() => {
                /** ignore */
            });
    }

    refreshHistory?.addEventListener('click', () => {
        loadPackagePagesMap().finally(() => {
            if (latestPackagesTable) latestPackagesTable.redraw();
            if (detailPackagesTable) detailPackagesTable.redraw();
            if (lastDashboardPayload) {
                renderLatestPackages(lastDashboardPayload.summary, lastDashboardPayload.result);
                renderResultsDashboard(lastDashboardPayload, { fromRefresh: true });
            } else if (!packagesSection?.hidden && lastLatestPackageRows.length) {
                renderPackagesStats(lastLatestPackageRows, lastLatestPinned);
            }
            loadHistory();
        });
    });

    loadPackagePagesMap().finally(() => {
        if (latestPackagesTable) latestPackagesTable.redraw();
        if (detailPackagesTable) detailPackagesTable.redraw();
        hydrateFromLastJob().finally(() => loadHistory());
    });
})();

