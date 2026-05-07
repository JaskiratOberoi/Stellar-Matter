(function () {
    const form = document.getElementById('run-form');
    const submitBtn = document.getElementById('submit-btn');
    const clearBtn = document.getElementById('clear-btn');
    const runStatus = document.getElementById('run-status');
    const latestStatusPill = document.getElementById('latest-status-pill');
    const latestEmpty = document.getElementById('latest-empty');
    const latestSummary = document.getElementById('latest-summary');
    const filtersAppliedLine = document.getElementById('filters-applied-line');
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
    /** Snapshot of latest scrape package rows for stats refresh after /api/package-pages loads */
    let lastLatestPackageRows = [];

    function syncOpenSidDisabled() {
        const dis = scrapePackages.checked;
        openSid.disabled = dis;
        if (dis) openSid.value = '';
    }

    scrapePackages.addEventListener('change', syncOpenSidDisabled);
    syncOpenSidDisabled();

    document.querySelectorAll('.tabs .tab').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tabs .tab').forEach((b) => b.classList.remove('active'));
            btn.classList.add('active');
            activeTab = btn.getAttribute('data-tab') || 'main';
            renderDetailPlaceholder();
            if (selectedId) loadDetail(selectedId);
        });
    });

    /** @param {string} s */
    function normalizePackageLabel(s) {
        return String(s || '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** @type {Record<string, number>} — keys are normalized labels; filled from GET /api/package-pages */
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
     * Pages per single printed report for this label (from summary row or `package-pages.json`).
     * @param {{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null }} row
     * @returns {number|null}
     */
    function resolvePagesPerReport(row) {
        if (row.isOther === true) return 1;
        if (row.pagesPerReport != null && Number.isFinite(Number(row.pagesPerReport))) {
            return Number(row.pagesPerReport);
        }
        if (row.totalPages != null && Number.isFinite(Number(row.totalPages))) {
            return Number(row.totalPages);
        }
        const n = clientPagesByNorm[normalizePackageLabel(row.label)];
        return Number.isFinite(n) ? n : null;
    }

    /**
     * Total printed pages across all occurrences: count × pages per report.
     * @param {{ label: string, count: number, pagesPerReport?: number|null, totalPages?: number|null }} row
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

    /**
     * Pinned synthetic row for bracket-less grid cells ("Other tests"): 1 page per cell.
     * @param {number} count
     * @returns {{ label: string, count: number, pagesPerReport: number, isOther: true }|null}
     */
    function makeOtherTestsPinned(count) {
        const n = Math.floor(Number(count)) || 0;
        if (n < 1) return null;
        return { label: 'Other tests', count: n, pagesPerReport: 1, isOther: true };
    }

    /** Stateful table — sort + filter; Total Pages = Count × mapped pages/report. */
    function createPackagesTable(host) {
        const state = {
            rows: [],
            pinned: /** @type {{ label: string, count: number, pagesPerReport?: number|null, isOther?: boolean }|null} */ (null),
            total: 0,
            sortKey: 'count',
            sortDir: 'desc',
            filter: '',
            onCount: null
        };

        function filtered() {
            const q = state.filter.trim().toLowerCase();
            const rs = q ? state.rows.filter((r) => r.label.toLowerCase().includes(q)) : state.rows.slice();
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

        /** Whole-run sum of Total Pages column (all rows including pinned); ignores UI filter/sort. */
        function aggregateWholeScanPrintedPages(pinnedRow) {
            let knownSum = 0;
            let unknownLabels = 0;
            /** @param {{ label?: string }} row */
            const add = (row) => {
                const p = resolveTotalPagesProduct(row);
                if (p == null) unknownLabels++;
                else knownSum += p;
            };
            if (pinnedRow) add(pinnedRow);
            state.rows.forEach(add);
            return { knownSum, unknownLabels };
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

            const { knownSum, unknownLabels } = aggregateWholeScanPrintedPages(hasPinned ? pinnedRow : null);
            const totalPagesCellNum = knownSum.toLocaleString('en-US');
            const totalPagesCellBody =
                unknownLabels === 0
                    ? escapeHtml(totalPagesCellNum)
                    : `${escapeHtml(totalPagesCellNum)} <span class="muted">${escapeHtml(
                          ` (${unknownLabels} label${unknownLabels === 1 ? '' : 's'} unmapped — minimum)`
                      )}</span>`;
            html +=
                '</tbody>' +
                '<tfoot>' +
                '<tr class="packages-tfoot-row">' +
                `<td colspan="3" class="packages-tfoot-label">${escapeHtml(
                    'Total pages — whole scan'
                )}</td>` +
                `<td class="pages-num packages-tfoot-pages">${totalPagesCellBody}</td>` +
                '</tr>' +
                '</tfoot>' +
                '</table>';
            host.innerHTML = html;

            host.querySelectorAll('th.sortable').forEach((th) => {
                th.addEventListener('click', () => {
                    const k = th.getAttribute('data-key');
                    if (state.sortKey === k) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
                    else {
                        state.sortKey = k;
                        state.sortDir = k === 'label' ? 'asc' : 'desc';
                    }
                    render();
                });
            });
        }

        return {
            setRows(rows, opts = {}) {
                state.rows = rows.slice();
                state.pinned = opts.pinned && opts.pinned.isOther && Number(opts.pinned.count) > 0 ? opts.pinned : null;
                state.total = rows.reduce((s, r) => s + r.count, 0);
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
                return { total: state.total, unique: state.rows.length };
            },
            redraw() {
                render();
            }
        };
    }

    const latestPackagesTable = packagesTableWrap ? createPackagesTable(packagesTableWrap) : null;
    const detailPackagesTable = detailPackagesWrap ? createPackagesTable(detailPackagesWrap) : null;

    if (packagesSearch && latestPackagesTable) {
        packagesSearch.addEventListener('input', (e) => latestPackagesTable.setFilter(e.target.value));
    }

    function renderPackagesStats(rows) {
        if (!packagesStats) return;
        const total = rows.reduce((s, r) => s + r.count, 0);
        const unique = rows.length;
        const unknownN = rows.filter((r) => !r.isOther && resolvePagesPerReport(r) == null).length;
        const parts = [
            `<span class="stat-pill"><span>Unique labels</span><strong>${unique}</strong></span>`,
            `<span class="stat-pill"><span>Total occurrences</span><strong>${total}</strong></span>`
        ];
        if (unknownN > 0) {
            parts.push(
                `<span class="stat-pill stat-pill-info"><span>Unknown packages</span><strong>${unknownN}</strong></span>`
            );
        }
        packagesStats.innerHTML = parts.join('');
    }

    function setShownCount(visible, total) {
        if (!packagesShown) return;
        packagesShown.textContent = visible === total ? `${total} label${total === 1 ? '' : 's'}` : `${visible} of ${total} labels`;
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

    function fmtPath(p) {
        if (!p) return '<span class="muted">—</span>';
        return `<span class="path">${escapeHtml(String(p))}</span>`;
    }

    function fmtBool(v) {
        return v ? 'yes' : '<span class="muted">no</span>';
    }

    function modeLabel(summary) {
        if (!summary) return '—';
        if (summary.dryRun) return 'dry-run';
        if (summary.scrapePackages) return 'package scrape';
        return 'normal search';
    }

    function renderLatestSummary(state) {
        if (!latestSummary) return;
        if (!state || (!state.summary && !state.error && state.exitCode == null)) {
            latestEmpty.hidden = false;
            latestSummary.hidden = true;
            latestSummary.innerHTML = '';
            return;
        }
        latestEmpty.hidden = true;
        latestSummary.hidden = false;

        const s = state.summary || {};
        const errCount = Array.isArray(s.errors) ? s.errors.length : 0;
        const rows = [];
        const push = (label, value, cls) => rows.push(
            `<tr><th>${escapeHtml(label)}</th><td${cls ? ` class="${cls}"` : ''}>${value}</td></tr>`
        );

        push('Status',
            state.exitCode === 0
                ? '<span class="status-pill ok">success</span>'
                : `<span class="status-pill err">exit ${escapeHtml(String(state.exitCode))}</span>`);
        if (state.error) push('Error', `<span class="errors-cell">${escapeHtml(state.error)}</span>`);
        push('Run id', state.runId ? `<code>${escapeHtml(state.runId)}</code>` : '—');
        push('Started', s.startedAt ? escapeHtml(s.startedAt) : '—');
        push('Mode', modeLabel(s));
        if (s.scrapePackages) {
            push('Pages scanned', escapeHtml(String(s.pagesScanned ?? 0)), 'value-num');
            push('Rows scraped', escapeHtml(String(s.rowCount ?? 0)), 'value-num');
            push('Unique labels', escapeHtml(String(s.uniqueLabelCount ?? 0)), 'value-num');
            const pv = Array.isArray(s.pageVisits) ? s.pageVisits : [];
            const pvText =
                pv.length === 0
                    ? '—'
                    : pv
                          .map((p) =>
                              `p.${p.index}` +
                              (p.pagerPage != null ? ` pager=${p.pagerPage}` : '') +
                              ` rows=${p.rowCount}` +
                              ` w/brackets=${p.rowsWithBracketLabels ?? 0}`
                          )
                          .join(' · ');
            const pageScanValue =
                pv.length === 0
                    ? '—'
                    : `<details class="page-scan-detail"><summary class="page-scan-detail-summary">${escapeHtml(
                          `Show per-page (${pv.length} pages)`
                      )}</summary><div class="page-scan-detail-body path">${escapeHtml(pvText)}</div></details>`;
            push('Page scan detail', pageScanValue);

            const rc = Number(s.recoveryCount) || 0;
            if (rc > 0) {
                const rev = Array.isArray(s.recoveryEvents) ? s.recoveryEvents : [];
                const lines = rev.map((ev) => {
                    const ok = ev.succeeded ? 'ok' : 'fail';
                    const pp = ev.atPagerPage != null ? ` pager=${ev.atPagerPage}` : '';
                    const err = ev.error ? ` err=${String(ev.error)}` : '';
                    return `#${ev.attempt} ${ok}${pp} ${String(ev.reason || '')}${err} @${String(ev.at || '')}`;
                });
                const detailText = lines.length ? lines.join(' · ') : `${rc} recovery event(s)`;
                const lcpp =
                    s.lastCompletedPagerPage != null && Number.isFinite(Number(s.lastCompletedPagerPage))
                        ? ` · last pager page scraped: ${s.lastCompletedPagerPage}`
                        : '';
                const sessionRecValue = `<details class="page-scan-detail"><summary class="page-scan-detail-summary">${escapeHtml(
                    `Session recoveries: ${rc}${lcpp} — show detail`
                )}</summary><div class="page-scan-detail-body path">${escapeHtml(detailText)}</div></details>`;
                push('Session recoveries', sessionRecValue, 'value-num');
            }
        }
        push('SIDs on page 1', escapeHtml(String(s.sidsOnPage1 ?? 0)), 'value-num');
        push('Errors',
            errCount === 0
                ? '0'
                : `<span class="errors-cell">${escapeHtml(s.errors.join('\n'))}</span>`,
            errCount === 0 ? 'value-num' : '');
        push('Main JSON', fmtPath(state.outMainPath || s.outMainPath));
        if (s.scrapePackages || state.outPackagesPath) push('Packages JSON', fmtPath(state.outPackagesPath || s.outPackagesPath));

        latestSummary.innerHTML = `<table class="summary">${rows.join('')}</table>`;
    }

    function clearLatest() {
        setStatusPill(null);
        runStatus.textContent = '';
        if (filtersAppliedLine) filtersAppliedLine.textContent = '';
        if (latestSummary) {
            latestSummary.hidden = true;
            latestSummary.innerHTML = '';
        }
        if (latestEmpty) {
            latestEmpty.hidden = false;
            latestEmpty.textContent = 'No run yet.';
        }
        if (packagesSection) packagesSection.hidden = true;
        lastLatestPackageRows = [];
    }

    if (clearBtn) clearBtn.addEventListener('click', clearLatest);

    function updateFiltersAppliedLine(result) {
        if (!filtersAppliedLine) return;
        const req = (result && result.filtersRequested) || {};
        const app = (result && result.filtersApplied) || {};
        const parts = [];
        if (req.bu != null && String(req.bu).trim()) {
            if (app.businessUnit) parts.push(`BU applied: ${app.businessUnit}`);
            else parts.push(`BU not applied (no match for “${String(req.bu).trim()}”)`);
        }
        if (req.status != null && String(req.status).trim()) {
            if (app.status) parts.push(`Status applied: ${app.status}`);
            else parts.push(`Status not applied (“${String(req.status).trim()}”)`);
        }
        if (req.testCode != null && String(req.testCode).trim() && !app.testCode) {
            parts.push(`Test code not applied`);
        }
        filtersAppliedLine.textContent = parts.length ? parts.join(' · ') : '';
    }

    function renderLatestPackages(summary, result) {
        if (!packagesSection || !latestPackagesTable) return;
        const isScrape = summary && summary.scrapePackages;
        let packageRows = [];
        if (summary && Array.isArray(summary.packageLabelRows)) {
            packageRows = summary.packageLabelRows;
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
        if (!isScrape || (!packageRows.length && !pinned)) {
            packagesSection.hidden = true;
            lastLatestPackageRows = [];
            return;
        }
        packagesSection.hidden = false;
        lastLatestPackageRows = packageRows.slice();
        renderPackagesStats(packageRows);
        latestPackagesTable.setRows(packageRows, { onCount: setShownCount, pinned });
        if (packagesSearch) packagesSearch.value = '';
        latestPackagesTable.setFilter('');
    }

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

    async function pollUntilIdle() {
        const r = await fetch('/api/run/status');
        const j = await r.json();
        if (j.state === 'running') {
            runStatus.textContent = 'Running…';
            setStatusPill('running', 'running');
            if (latestEmpty) {
                latestEmpty.hidden = false;
                latestEmpty.textContent = `Running… (run ${j.runId || ''})`;
            }
            return false;
        }
        runStatus.textContent = j.exitCode === 0 ? 'Finished.' : 'Finished with errors.';
        setStatusPill(j.exitCode === 0 ? 'ok' : 'err', j.exitCode === 0 ? 'success' : 'error');
        updateFiltersAppliedLine(j.result);
        renderLatestPackages(j.summary, j.result);
        renderLatestSummary(j);
        submitBtn.disabled = false;
        loadHistory();
        return true;
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        submitBtn.disabled = true;
        runStatus.textContent = 'Starting…';
        setStatusPill('running', 'starting');
        if (filtersAppliedLine) filtersAppliedLine.textContent = '';
        if (latestSummary) {
            latestSummary.hidden = true;
            latestSummary.innerHTML = '';
        }
        if (latestEmpty) {
            latestEmpty.hidden = false;
            latestEmpty.textContent = 'Starting…';
        }
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
                if (latestEmpty) {
                    latestEmpty.hidden = false;
                    latestEmpty.textContent = j.error || 'A run is already in progress.';
                }
                submitBtn.disabled = false;
                return;
            }
            if (!r.ok) {
                runStatus.textContent = 'Error';
                if (latestEmpty) {
                    latestEmpty.hidden = false;
                    latestEmpty.textContent = j.error ? String(j.error) : JSON.stringify(j, null, 2);
                }
                submitBtn.disabled = false;
                return;
            }
            const doneNow = await pollUntilIdle();
            if (!doneNow) {
                pollTimer = setInterval(async () => {
                    if (await pollUntilIdle()) {
                        clearInterval(pollTimer);
                        pollTimer = null;
                    }
                }, 1500);
            }
        } catch (e) {
            runStatus.textContent = 'Request failed';
            if (latestEmpty) {
                latestEmpty.hidden = false;
                latestEmpty.textContent = String(e);
            }
            submitBtn.disabled = false;
        }
    });

    async function loadHistory() {
        try {
            const r = await fetch('/api/runs');
            const j = await r.json();
            historyPath.textContent = j.outDir ? `Scanning: ${j.outDir}` : '';
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
                    document.querySelectorAll('#history-table tbody tr').forEach((t) => t.classList.remove('selected'));
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

    async function loadDetail(id) {
        if (!id) return;
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

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    refreshHistory.addEventListener('click', () => {
        loadPackagePagesMap().finally(() => {
            if (latestPackagesTable) latestPackagesTable.redraw();
            if (detailPackagesTable) detailPackagesTable.redraw();
            if (!packagesSection.hidden && lastLatestPackageRows.length) renderPackagesStats(lastLatestPackageRows);
            loadHistory();
        });
    });

    loadPackagePagesMap().finally(() => {
        if (latestPackagesTable) latestPackagesTable.redraw();
        if (detailPackagesTable) detailPackagesTable.redraw();
        if (!packagesSection.hidden && lastLatestPackageRows.length) renderPackagesStats(lastLatestPackageRows);
        loadHistory();
    });
})();
