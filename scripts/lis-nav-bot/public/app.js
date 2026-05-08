(function () {
    const LS_VIEW = 'lisbot:view';
    const LS_SIDEBAR = 'lisbot:sidebar';
    const LS_SOURCE = 'lisbot:source';
    const LS_HIDDEN = 'lisbot:hidden-tiles';
    const LS_BU_SELECTION = 'lisbot:bu-selection';

    const form = document.getElementById('run-form');
    const submitBtn = document.getElementById('submit-btn');
    const clearBtn = document.getElementById('clear-btn');
    const runStatus = document.getElementById('run-status');
    const latestStatusPill = document.getElementById('latest-status-pill');
    const sidebarToggle = document.getElementById('sidebar-toggle');
    const appShell = document.getElementById('app-shell');
    const runSidebar = document.getElementById('run-sidebar');

    const lastUpdatedEl = document.getElementById('last-updated');
    const viewResults = document.getElementById('view-results');
    const viewHistory = document.getElementById('view-history');
    const tabResultsBtn = document.getElementById('tab-results');
    const tabHistoryBtn = document.getElementById('tab-history');

    const runProgressWrap = document.getElementById('run-progress-wrap');
    const runProgressStrip = document.getElementById('run-progress-strip');
    const resultsError = document.getElementById('results-error');
    const tileEmpty = document.getElementById('tile-empty');
    const tileGrid = document.getElementById('tile-grid');
    const restoreHiddenWrap = document.getElementById('restore-hidden-wrap');
    const restoreHiddenBtn = document.getElementById('restore-hidden-btn');

    const dateChipRow = document.getElementById('date-quick-chips');
    const buChipGrid = document.getElementById('bu-chip-grid');
    const buChipAllBtn = document.getElementById('bu-chip-all');
    const buChipClearBtn = document.getElementById('bu-chip-clear-selection');
    const buLookupError = document.getElementById('bu-lookup-error');
    const buFreeText = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="bu"]'));
    const fromDateInput = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="fromDate"]'));
    const toDateInput = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="toDate"]'));

    const runModal = /** @type {HTMLDialogElement|null} */ (document.getElementById('run-modal'));
    const runModalEyebrow = document.getElementById('run-modal-eyebrow');
    const runModalTitle = document.getElementById('run-modal-title');
    const runModalSub = document.getElementById('run-modal-sub');
    const runModalClose = document.getElementById('run-modal-close');
    const runModalPaths = document.getElementById('run-modal-paths');
    const modalPackagesWrap = document.getElementById('modal-packages-wrap');
    const modalPackagesSearch = /** @type {HTMLInputElement|null} */ (document.getElementById('modal-packages-search'));
    const modalPackagesShown = document.getElementById('modal-packages-shown');
    const runModalTotalPages = document.getElementById('run-modal-total-pages');
    const runModalEstChip = document.getElementById('run-modal-est-chip');

    const historyTable = /** @type {HTMLTableSectionElement|null} */ (document.querySelector('#history-table tbody'));
    const historyPath = document.getElementById('history-path');
    const refreshHistory = document.getElementById('refresh-history');
    const detailJson = document.getElementById('detail-json');
    const detailPackagesWrap = document.getElementById('detail-packages-table-wrap');
    const scrapePackages = /** @type {HTMLInputElement|null} */ (document.getElementById('scrapePackages'));
    const openSid = /** @type {HTMLInputElement|null} */ (document.getElementById('openSid'));

    let activeTab = 'main';
    let pollTimer = /** @type {ReturnType<typeof setInterval>|null} */ (null);
    let selectedId = /** @type {string|null} */ (null);

    /** @type {{ id: string, label: string }[]} */
    let buOptions = [];
    /** @type {Set<string>} */
    let buSelected = new Set();
    /** @type {{ tiles: any[], errors: any[] }} */
    let lastTilePayload = { tiles: [], errors: [] };
    /** @type {any[]} */
    let visibleTiles = [];

    /** @type {'results'|'history'} */
    let currentView =
        typeof localStorage !== 'undefined' && localStorage.getItem(LS_VIEW) === 'history' ? 'history' : 'results';

    function escapeHtml(s) {
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function readHiddenSet() {
        try {
            const raw = localStorage.getItem(LS_HIDDEN);
            if (!raw) return new Set();
            const arr = JSON.parse(raw);
            return new Set(Array.isArray(arr) ? arr.map(String) : []);
        } catch {
            return new Set();
        }
    }

    function writeHiddenSet(set) {
        try {
            localStorage.setItem(LS_HIDDEN, JSON.stringify([...set]));
        } catch {
            /**/
        }
    }

    function syncOpenSidDisabled() {
        if (!scrapePackages) return;
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
        let clearT = /** @type {ReturnType<typeof setTimeout>|null} */ (null);
        let awaitingSecond = false;
        window.addEventListener(
            'keydown',
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

    /* ------------------------------------------------------------------ */
    /* Package-pages map + label helpers (shared with modal table)        */
    /* ------------------------------------------------------------------ */

    function normalizePackageLabel(s) {
        return String(s || '')
            .replace(/\s+/g, ' ')
            .trim()
            .toUpperCase();
    }

    /** @type {Record<string, number>} */
    let clientPagesByNorm = {};

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

    function resolvePagesPerReport(row) {
        if (row.isOther === true) return 1;
        if (row.pagesPerReport != null && Number.isFinite(Number(row.pagesPerReport))) return Number(row.pagesPerReport);
        if (row.totalPages != null && Number.isFinite(Number(row.totalPages))) return Number(row.totalPages);
        const n = clientPagesByNorm[normalizePackageLabel(row.label)];
        return Number.isFinite(n) ? n : null;
    }

    function resolveTotalPagesProduct(row) {
        const ppr = resolvePagesPerReport(row);
        if (ppr == null) return null;
        const c = Number(row.count) || 0;
        return c * ppr;
    }

    function rowsFromLabelOccurrences(occ) {
        if (!occ || typeof occ !== 'object') return [];
        return Object.entries(occ).map(([label, count]) => ({ label, count: Number(count) || 0 }));
    }

    function makeOtherTestsPinned(count) {
        const n = Math.floor(Number(count)) || 0;
        if (n < 1) return null;
        return { label: 'Other tests', count: n, pagesPerReport: 1, isOther: /** @type {const} */ (true) };
    }

    function aggregateWholeScanPrintedPagesFromRows(bodyRows, pinnedRow) {
        let knownSum = 0;
        let unknownLabels = 0;
        const add = (row) => {
            const p = resolveTotalPagesProduct(row);
            if (p == null) unknownLabels++;
            else knownSum += p;
        };
        if (pinnedRow && Number(pinnedRow.count) > 0) add(pinnedRow);
        (bodyRows || []).forEach(add);
        return { knownSum, unknownLabels };
    }

    /* ------------------------------------------------------------------ */
    /* Reusable per-package sortable/filterable table                      */
    /* ------------------------------------------------------------------ */

    function createPackagesTable(host) {
        if (!host) {
            return {
                setRows() {},
                setFilter() {},
                redraw() {},
                getStats: () => ({ total: 0, unique: 0 }),
                getAggregates: () => ({ knownSum: 0, unknownLabels: 0 })
            };
        }

        const state = /** @type {any} */ ({
            rows: [],
            pinned: null,
            sortKey: 'count',
            sortDir: 'desc',
            filter: '',
            onCount: null
        });

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
                        ? `<td class="pages-num">${escapeHtml(totalPagesProduct.toLocaleString('en-US'))}</td>`
                        : '<td class="pages-cell"><span class="unknown-chip">unknown</span></td>';
                html +=
                    '<tr class="pinned-row">' +
                    '<td class="rank rank-pinned">—</td>' +
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
                        ? `<td class="pages-num">${escapeHtml(totalPagesProduct.toLocaleString('en-US'))}</td>`
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
                '</tbody><tfoot><tr class="packages-tfoot-row">' +
                `<td colspan="3" class="packages-tfoot-label">${escapeHtml('Total printed pages · whole scan')}</td>` +
                `<td class="${tfootPagesCls}">${totalPagesCellBody}${
                    unknownLabels > 0 ? ' <span class="muted estimated-chip-inline">estimated</span>' : ''
                }</td>` +
                '</tr></tfoot></table>';

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
            setRows(rows, opts = {}) {
                state.rows = (rows || []).slice();
                state.pinned = opts.pinned && opts.pinned.isOther && Number(opts.pinned.count) > 0 ? opts.pinned : null;
                state.onCount = opts.onCount || null;
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
                    total: state.rows.reduce((s, r) => s + r.count, 0) + (state.pinned ? state.pinned.count : 0),
                    unique: state.rows.length + (state.pinned ? 1 : 0)
                };
            },
            getAggregates() {
                return aggregateWholeScanPrintedPagesFromRows(state.rows, state.pinned);
            },
            redraw() {
                render();
            }
        };
    }

    const detailPackagesTable = detailPackagesWrap ? createPackagesTable(detailPackagesWrap) : null;
    const modalPackagesTable = modalPackagesWrap ? createPackagesTable(modalPackagesWrap) : null;

    if (modalPackagesSearch && modalPackagesTable) {
        modalPackagesSearch.addEventListener('input', (e) => {
            modalPackagesTable.setFilter(/** @type {HTMLInputElement} */ (e.target).value);
        });
    }

    /* ------------------------------------------------------------------ */
    /* Status pill + last-updated                                          */
    /* ------------------------------------------------------------------ */

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
        if (lastUpdatedEl) {
            lastUpdatedEl.textContent = `Updated ${new Date().toLocaleTimeString(undefined, {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            })}`;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Source picker                                                       */
    /* ------------------------------------------------------------------ */

    function applySourceVisibility(source) {
        const wantSql = source === 'sql';
        form.querySelectorAll('[data-source-only]').forEach((el) => {
            const tag = el.getAttribute('data-source-only');
            /** @type {HTMLElement} */ (el).hidden = wantSql && tag === 'scrape';
        });
        const hint = document.getElementById('source-hint');
        if (hint) {
            hint.textContent = wantSql
                ? 'Calls the Listec service (LISTEC_API_BASE_URL, default http://127.0.0.1:3100) — multi-BU runs allowed.'
                : 'Drives the LIS web grid via headless Chromium. Multi-BU runs require SQL.';
        }
        renderBuChips();
    }

    function getSourceFromForm() {
        const radio = /** @type {HTMLInputElement|null} */ (form.querySelector('input[name="source"]:checked'));
        return radio ? String(radio.value) : 'scrape';
    }

    function setSourceOnForm(value) {
        const v = value === 'sql' ? 'sql' : 'scrape';
        const radio = /** @type {HTMLInputElement|null} */ (form.querySelector(`input[name="source"][value="${v}"]`));
        if (radio) radio.checked = true;
        applySourceVisibility(v);
    }

    try {
        setSourceOnForm(localStorage.getItem(LS_SOURCE) || 'scrape');
    } catch {
        applySourceVisibility('scrape');
    }

    form.querySelectorAll('input[name="source"]').forEach((radio) => {
        radio.addEventListener('change', () => {
            const v = getSourceFromForm();
            try {
                localStorage.setItem(LS_SOURCE, v);
            } catch {
                /**/
            }
            applySourceVisibility(v);
        });
    });

    /* ------------------------------------------------------------------ */
    /* Date quick picks                                                    */
    /* ------------------------------------------------------------------ */

    function pad2(n) {
        return String(n).padStart(2, '0');
    }
    function fmtDDMMYYYY(d) {
        return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
    }
    function offsetDays(n) {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() + n);
        return d;
    }
    function todayRange() {
        const d = offsetDays(0);
        return { from: d, to: d };
    }
    function singleDay(n) {
        const d = offsetDays(n);
        return { from: d, to: d };
    }
    function lastNDays(n) {
        return { from: offsetDays(-n), to: offsetDays(0) };
    }
    function monthRange(monthOffset) {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth() + monthOffset, 1);
        const end = new Date(now.getFullYear(), now.getMonth() + monthOffset + 1, 0);
        start.setHours(0, 0, 0, 0);
        end.setHours(0, 0, 0, 0);
        return { from: start, to: end };
    }

    const QUICK = [
        { id: 'today', label: 'TODAY', build: todayRange },
        { id: 'yest', label: 'YESTERDAY', build: () => singleDay(-1) },
        { id: 'last7', label: '\u22127D', build: () => lastNDays(6) },
        { id: 'thisMonth', label: 'THIS MONTH', build: () => monthRange(0) },
        { id: 'lastMonth', label: 'LAST MONTH', build: () => monthRange(-1) }
    ];

    function rangesEqual(rangeFromInputs, target) {
        if (!fromDateInput || !toDateInput) return false;
        return fromDateInput.value === fmtDDMMYYYY(target.from) && toDateInput.value === fmtDDMMYYYY(target.to);
    }

    function syncDateChipState() {
        if (!dateChipRow) return;
        dateChipRow.querySelectorAll('.chip[data-quick]').forEach((btn) => {
            const id = btn.getAttribute('data-quick');
            const def = QUICK.find((q) => q.id === id);
            const pressed = !!(def && rangesEqual(null, def.build()));
            btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
        });
    }

    function renderDateChips() {
        if (!dateChipRow) return;
        dateChipRow.innerHTML = QUICK.map(
            (q) => `<button type="button" class="chip" data-quick="${q.id}" aria-pressed="false">${escapeHtml(q.label)}</button>`
        ).join('');
        dateChipRow.querySelectorAll('button.chip[data-quick]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-quick');
                const def = QUICK.find((q) => q.id === id);
                if (!def || !fromDateInput || !toDateInput) return;
                const r = def.build();
                fromDateInput.value = fmtDDMMYYYY(r.from);
                toDateInput.value = fmtDDMMYYYY(r.to);
                syncDateChipState();
            });
        });
    }
    renderDateChips();
    fromDateInput?.addEventListener('input', syncDateChipState);
    toDateInput?.addEventListener('input', syncDateChipState);

    /* ------------------------------------------------------------------ */
    /* BU chips                                                            */
    /* ------------------------------------------------------------------ */

    function loadBuSelection() {
        try {
            const raw = localStorage.getItem(LS_BU_SELECTION);
            if (!raw) return new Set();
            const arr = JSON.parse(raw);
            return new Set(Array.isArray(arr) ? arr.map(String) : []);
        } catch {
            return new Set();
        }
    }

    function saveBuSelection() {
        try {
            localStorage.setItem(LS_BU_SELECTION, JSON.stringify([...buSelected]));
        } catch {
            /**/
        }
    }

    buSelected = loadBuSelection();

    function renderBuChips() {
        if (!buChipGrid) return;
        const wantSql = getSourceFromForm() === 'sql';
        const fallback = form.querySelector('.bu-fallback-label');
        if (fallback) /** @type {HTMLElement} */ (fallback).hidden = wantSql && buOptions.length > 0;
        if (!wantSql || !buOptions.length) {
            buChipGrid.innerHTML = '';
            buChipGrid.hidden = !wantSql;
            buChipAllBtn && (buChipAllBtn.disabled = !wantSql || !buOptions.length);
            buChipClearBtn && (buChipClearBtn.disabled = !wantSql || !buSelected.size);
            return;
        }
        buChipGrid.hidden = false;
        buChipGrid.innerHTML = buOptions
            .map((opt) => {
                const pressed = buSelected.has(opt.label) ? 'true' : 'false';
                const safe = escapeHtml(opt.label);
                return `<button type="button" class="chip bu-chip" data-bu="${safe}" aria-pressed="${pressed}">${safe}</button>`;
            })
            .join('');
        buChipGrid.querySelectorAll('button.bu-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const v = btn.getAttribute('data-bu') || '';
                if (!v) return;
                if (buSelected.has(v)) buSelected.delete(v);
                else buSelected.add(v);
                saveBuSelection();
                btn.setAttribute('aria-pressed', buSelected.has(v) ? 'true' : 'false');
                buChipClearBtn && (buChipClearBtn.disabled = !buSelected.size);
            });
        });
        buChipAllBtn && (buChipAllBtn.disabled = false);
        buChipClearBtn && (buChipClearBtn.disabled = !buSelected.size);
    }

    buChipAllBtn?.addEventListener('click', () => {
        for (const opt of buOptions) buSelected.add(opt.label);
        saveBuSelection();
        renderBuChips();
    });
    buChipClearBtn?.addEventListener('click', () => {
        buSelected.clear();
        saveBuSelection();
        renderBuChips();
    });

    function loadBuOptions() {
        return fetch('/api/bu')
            .then((r) => r.json())
            .then((j) => {
                const list = Array.isArray(j.businessUnits) ? j.businessUnits : [];
                buOptions = list
                    .map((row) => {
                        if (typeof row === 'string') return { id: row, label: row };
                        const label = String(row.name || row.label || row.id || '').trim();
                        const id = row.id != null ? String(row.id) : label;
                        return label ? { id, label } : null;
                    })
                    .filter(Boolean)
                    .sort((a, b) => a.label.localeCompare(b.label));
                if (buLookupError) {
                    if (j.error) {
                        buLookupError.hidden = false;
                        buLookupError.textContent = `Could not reach Listec lookups (${j.error}); using free-text BU.`;
                    } else {
                        buLookupError.hidden = true;
                        buLookupError.textContent = '';
                    }
                }
                const known = new Set(buOptions.map((o) => o.label));
                for (const v of [...buSelected]) if (!known.has(v)) buSelected.delete(v);
                renderBuChips();
            })
            .catch((e) => {
                buOptions = [];
                if (buLookupError) {
                    buLookupError.hidden = false;
                    buLookupError.textContent = `BU lookup failed: ${String(e)}`;
                }
                renderBuChips();
            });
    }

    /* ------------------------------------------------------------------ */
    /* Tile wall                                                           */
    /* ------------------------------------------------------------------ */

    function tileEyebrow(tile, indexFromOne) {
        const idx = String(indexFromOne).padStart(2, '0');
        const src = String(tile.source || 'scrape').toUpperCase();
        let timeStr = '';
        if (tile.startedAt) {
            const d = new Date(tile.startedAt);
            if (!Number.isNaN(d.getTime())) {
                timeStr = d.toLocaleString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                    day: '2-digit',
                    month: 'short'
                });
            }
        }
        const parts = [`${idx} / RUN`, src];
        if (timeStr) parts.push(timeStr);
        return parts.join(' \u00b7 ');
    }

    function fmtRange(fromDate, toDate) {
        const from = (fromDate || '').trim();
        const to = (toDate || '').trim();
        if (!from && !to) return 'No date window';
        if (from && to && from === to) return from;
        if (from && to) return `${from} \u2192 ${to}`;
        return from || to;
    }

    function topLabelFromTile(tile) {
        if (!tile || !Array.isArray(tile.labelRows)) return null;
        let best = null;
        for (const r of tile.labelRows) {
            if (!best || Number(r.count) > Number(best.count)) best = r;
        }
        return best;
    }

    function renderTileEmpty(hiddenCount) {
        if (tileEmpty) tileEmpty.hidden = false;
        if (tileGrid) {
            tileGrid.hidden = true;
            tileGrid.innerHTML = '';
        }
        if (restoreHiddenWrap && restoreHiddenBtn) {
            if (hiddenCount > 0) {
                restoreHiddenWrap.hidden = false;
                restoreHiddenBtn.textContent = `Restore ${hiddenCount} hidden run${hiddenCount === 1 ? '' : 's'}`;
            } else {
                restoreHiddenWrap.hidden = true;
                restoreHiddenBtn.textContent = '';
            }
        }
    }

    function renderTileGrid(tiles) {
        visibleTiles = tiles.slice();
        if (!tileGrid) return;
        if (!tiles.length) {
            const hidden = readHiddenSet();
            renderTileEmpty(hidden.size);
            return;
        }
        if (tileEmpty) tileEmpty.hidden = true;
        tileGrid.hidden = false;

        const totalsRecomputed = tiles.map((t) => {
            const rows = Array.isArray(t.labelRows) ? t.labelRows : [];
            const pinned = makeOtherTestsPinned(t.totals && t.totals.otherTestsRowCount);
            const agg = aggregateWholeScanPrintedPagesFromRows(rows, pinned);
            return { knownSum: agg.knownSum, estimated: agg.unknownLabels > 0 };
        });

        tileGrid.innerHTML = tiles
            .map((t, i) => {
                const eyebrow = tileEyebrow(t, i + 1);
                const buLabel = String(t.bu || '\u2014');
                const dateRange = fmtRange(t.fromDate, t.toDate);
                const top = topLabelFromTile(t);
                const totals = totalsRecomputed[i];
                const totalNum = totals.knownSum.toLocaleString('en-US');
                const topLabel = top
                    ? `${escapeHtml(String(top.label).toUpperCase())}${
                          top.count != null ? ` <span class="muted small">\u00d7 ${escapeHtml(String(top.count))}</span>` : ''
                      }`
                    : '<span class="muted small">no labels</span>';
                const sids = (t.totals && t.totals.sids) || 0;
                const occ = (t.totals && t.totals.occurrences) || 0;
                const uniq = (t.totals && t.totals.uniqueLabels) || 0;
                const errors = (t.totals && t.totals.errors) || 0;
                const stats = [
                    `${sids.toLocaleString('en-US')} SIDs`,
                    `${uniq.toLocaleString('en-US')} labels`,
                    `${occ.toLocaleString('en-US')} occ.`
                ];
                if (errors > 0) stats.push(`${errors} errors`);
                const estChip = totals.estimated ? '<span class="tile-est">estimated minimum</span>' : '<span></span>';
                return (
                    `<button type="button" class="tile" data-tile-id="${escapeHtml(t.id)}">` +
                    `<span class="tile-eyebrow">${escapeHtml(eyebrow)}</span>` +
                    `<h3 class="tile-title">${escapeHtml(buLabel)}</h3>` +
                    `<p class="tile-sub">${escapeHtml(dateRange)}</p>` +
                    `<div class="tile-metric-row">` +
                    `<span class="tile-metric-num">${escapeHtml(totalNum)}</span>` +
                    `<span class="tile-metric-label">${topLabel}</span>` +
                    `</div>` +
                    `<p class="tile-stats">${stats.map(escapeHtml).join(' \u00b7 ')}</p>` +
                    `<div class="tile-footer">` +
                    `<span class="tile-cta">view breakdown \u2192</span>` +
                    estChip +
                    `</div>` +
                    `</button>`
                );
            })
            .join('');

        tileGrid.querySelectorAll('button.tile[data-tile-id]').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.getAttribute('data-tile-id');
                const tile = visibleTiles.find((t) => String(t.id) === String(id));
                if (tile) openRunModal(tile);
            });
        });
    }

    function loadTiles() {
        return fetch('/api/runs/tiles')
            .then((r) => r.json())
            .then((j) => {
                lastTilePayload = { tiles: Array.isArray(j.tiles) ? j.tiles : [], errors: j.errors || [] };
                const hidden = readHiddenSet();
                const visible = lastTilePayload.tiles.filter((t) => !hidden.has(String(t.id)));
                if (resultsError) {
                    if (lastTilePayload.errors.length) {
                        resultsError.hidden = false;
                        resultsError.textContent = `Tile load: ${lastTilePayload.errors
                            .map((e) => `${e.file}: ${e.error}`)
                            .join(' · ')}`;
                    } else {
                        resultsError.hidden = true;
                        resultsError.textContent = '';
                    }
                }
                renderTileGrid(visible);
                bumpLastUpdated();
            })
            .catch((e) => {
                if (resultsError) {
                    resultsError.hidden = false;
                    resultsError.textContent = `Failed to load tiles: ${String(e)}`;
                }
            });
    }

    restoreHiddenBtn?.addEventListener('click', () => {
        try {
            localStorage.removeItem(LS_HIDDEN);
        } catch {
            /**/
        }
        loadTiles();
    });

    /* ------------------------------------------------------------------ */
    /* Run progress strip (multi-BU fan-out)                               */
    /* ------------------------------------------------------------------ */

    function setRunProgress(payload) {
        if (!runProgressWrap || !runProgressStrip) return;
        if (!payload) {
            runProgressWrap.hidden = true;
            runProgressStrip.innerHTML = '';
            return;
        }
        const items = Array.isArray(payload.items) ? payload.items : [];
        const total = items.length;
        const done = items.filter((it) => it.state === 'done').length;
        const lead = `${done}/${total}`;
        const cells = items
            .map((it) => {
                const name = escapeHtml(String(it.bu || '\u2014'));
                const mark =
                    it.state === 'done'
                        ? '\u2713'
                        : it.state === 'running'
                          ? '\u23f3'
                          : it.state === 'failed'
                            ? '\u00d7'
                            : '\u2026';
                return `${name} ${mark}`;
            })
            .join(' \u00b7 ');
        runProgressStrip.textContent = `${lead}  ${cells}`;
        runProgressWrap.hidden = false;
    }

    /* ------------------------------------------------------------------ */
    /* Modal                                                               */
    /* ------------------------------------------------------------------ */

    function openRunModal(tile) {
        if (!runModal || !modalPackagesTable) return;
        const idx = visibleTiles.findIndex((t) => String(t.id) === String(tile.id));
        const eyebrow = tileEyebrow(tile, idx >= 0 ? idx + 1 : 1);
        if (runModalEyebrow) runModalEyebrow.textContent = eyebrow;
        if (runModalTitle) runModalTitle.textContent = String(tile.bu || '\u2014');
        if (runModalSub) {
            const range = fmtRange(tile.fromDate, tile.toDate);
            const errs = (tile.totals && tile.totals.errors) || 0;
            const status = errs > 0 ? `${errs} error${errs === 1 ? '' : 's'}` : 'success';
            runModalSub.textContent = `${range} \u00b7 ${status}`;
        }
        if (runModalPaths) {
            const main = tile.paths && tile.paths.mainJson;
            const pkg = tile.paths && tile.paths.packagesJson;
            const parts = [];
            if (main) parts.push(`main: ${escapeHtml(String(main))}`);
            if (pkg) parts.push(`packages: ${escapeHtml(String(pkg))}`);
            runModalPaths.innerHTML = parts.join(' \u00b7 ');
        }

        const rows = Array.isArray(tile.labelRows) ? tile.labelRows : [];
        const pinned = makeOtherTestsPinned(tile.totals && tile.totals.otherTestsRowCount);
        modalPackagesTable.setRows(rows, {
            pinned,
            onCount: (visible, total) => {
                if (modalPackagesShown) {
                    modalPackagesShown.textContent =
                        visible === total ? `${total} label${total === 1 ? '' : 's'}` : `${visible} of ${total} labels`;
                }
            }
        });
        if (modalPackagesSearch) {
            modalPackagesSearch.value = '';
            modalPackagesTable.setFilter('');
        }
        const agg = modalPackagesTable.getAggregates();
        if (runModalTotalPages) runModalTotalPages.textContent = agg.knownSum.toLocaleString('en-US');
        if (runModalEstChip) runModalEstChip.hidden = agg.unknownLabels === 0;

        if (typeof runModal.showModal === 'function') {
            try {
                runModal.showModal();
            } catch {
                runModal.setAttribute('open', '');
            }
        } else {
            runModal.setAttribute('open', '');
        }
    }

    function closeRunModal() {
        if (!runModal) return;
        try {
            if (typeof runModal.close === 'function') runModal.close();
            else runModal.removeAttribute('open');
        } catch {
            runModal.removeAttribute('open');
        }
    }

    runModalClose?.addEventListener('click', closeRunModal);
    runModal?.addEventListener('click', (e) => {
        if (e.target === runModal) closeRunModal();
    });
    runModal?.addEventListener('cancel', (e) => {
        e.preventDefault();
        closeRunModal();
    });

    /* ------------------------------------------------------------------ */
    /* Submit + polling                                                    */
    /* ------------------------------------------------------------------ */

    function formToBody() {
        const fd = new FormData(form);
        /** @type {Record<string, any>} */
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
        body.source = getSourceFromForm();
        if (body.source === 'sql' && buSelected.size > 0) {
            body.businessUnits = [...buSelected];
            if (body.businessUnits.length === 1 && !body.bu) body.bu = body.businessUnits[0];
        }
        return body;
    }

    function showError(msg) {
        if (!resultsError) return;
        resultsError.hidden = false;
        resultsError.textContent = msg;
    }

    function clearError() {
        if (resultsError) {
            resultsError.hidden = true;
            resultsError.textContent = '';
        }
    }

    async function pollUntilIdle() {
        const r = await fetch('/api/run/status');
        const j = await r.json();
        if (j.state === 'running') {
            runStatus.textContent = 'Running…';
            setStatusPill('running', 'running');
            if (j.fanOut) setRunProgress(j.fanOut);
            return false;
        }
        runStatus.textContent = j.exitCode === 0 ? 'Finished.' : 'Finished with errors.';
        setStatusPill(j.exitCode === 0 ? 'ok' : 'err', j.exitCode === 0 ? 'success' : 'error');
        if (j.lastFanOut) {
            setRunProgress(j.lastFanOut);
            setTimeout(() => setRunProgress(null), 4500);
        } else {
            setRunProgress(null);
        }
        if (j.error) showError(j.error);
        else clearError();
        if (submitBtn) submitBtn.disabled = false;
        await loadTiles();
        loadHistory();
        return true;
    }

    form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        if (submitBtn) submitBtn.disabled = true;
        runStatus.textContent = 'Starting…';
        setStatusPill('running', 'starting');
        clearError();

        const body = formToBody();
        if (Array.isArray(body.businessUnits) && body.businessUnits.length > 0) {
            const items = body.businessUnits.map((bu) => ({ bu, state: 'queued' }));
            setRunProgress({ batchRunId: 'pending', queued: body.businessUnits, completed: [], failed: [], items });
        } else {
            setRunProgress(null);
            if (runProgressWrap) runProgressWrap.hidden = false;
            if (runProgressStrip) runProgressStrip.textContent = 'Starting run…';
        }

        try {
            const r = await fetch('/api/run', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const j = await r.json();
            if (r.status === 409) {
                runStatus.textContent = j.error || 'Busy';
                setStatusPill('err', 'busy');
                if (submitBtn) submitBtn.disabled = false;
                setRunProgress(null);
                return;
            }
            if (!r.ok) {
                runStatus.textContent = 'Error';
                setStatusPill('err', 'error');
                showError(j.error ? String(j.error) : JSON.stringify(j, null, 2));
                if (submitBtn) submitBtn.disabled = false;
                setRunProgress(null);
                return;
            }

            pollTimer = null;
            const doneNow = await pollUntilIdle();
            if (!doneNow) {
                pollTimer = setInterval(async () => {
                    if (await pollUntilIdle()) {
                        if (pollTimer) clearInterval(pollTimer);
                        pollTimer = null;
                    }
                }, 1500);
            }
        } catch (e) {
            runStatus.textContent = 'Request failed';
            setStatusPill('err', 'error');
            showError(String(e));
            if (submitBtn) submitBtn.disabled = false;
            setRunProgress(null);
        }
    });

    /* ------------------------------------------------------------------ */
    /* Clear ledger (hide tiles in localStorage)                           */
    /* ------------------------------------------------------------------ */

    clearBtn?.addEventListener('click', () => {
        if (!visibleTiles.length) {
            if (confirm('No visible tiles. Restore previously hidden tiles from localStorage?')) {
                try {
                    localStorage.removeItem(LS_HIDDEN);
                } catch {
                    /**/
                }
                loadTiles();
            }
            return;
        }
        if (!confirm(`Hide all ${visibleTiles.length} tile(s)? Files in /out are kept.`)) return;
        const hidden = readHiddenSet();
        for (const t of visibleTiles) hidden.add(String(t.id));
        writeHiddenSet(hidden);
        loadTiles();
    });

    /* ------------------------------------------------------------------ */
    /* History view                                                        */
    /* ------------------------------------------------------------------ */

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
        if (!selectedId && detailJson) {
            detailJson.textContent = '—';
            if (detailPackagesWrap) {
                detailPackagesWrap.hidden = true;
                detailPackagesWrap.innerHTML = '';
            }
            detailJson.hidden = false;
        }
    }

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
                    const otherN = j.packages && typeof j.packages.otherTestsRowCount === 'number' ? j.packages.otherTestsRowCount : 0;
                    detailPackagesTable.setRows(rows, { pinned: makeOtherTestsPinned(otherN) });
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

    refreshHistory?.addEventListener('click', () => {
        loadPackagePagesMap().finally(() => {
            if (detailPackagesTable) detailPackagesTable.redraw();
            loadTiles();
            loadHistory();
        });
    });

    /* ------------------------------------------------------------------ */
    /* Boot                                                                */
    /* ------------------------------------------------------------------ */

    function hydrateFromLastJob() {
        return fetch('/api/run/status')
            .then((r) => r.json())
            .then((j) => {
                if (!j) return;
                if (j.state === 'running') {
                    runStatus.textContent = 'Running…';
                    setStatusPill('running', 'running');
                    if (j.fanOut) setRunProgress(j.fanOut);
                    if (!pollTimer) {
                        pollTimer = setInterval(async () => {
                            if (await pollUntilIdle()) {
                                if (pollTimer) clearInterval(pollTimer);
                                pollTimer = null;
                            }
                        }, 1500);
                    }
                } else if (typeof j.exitCode === 'number') {
                    setStatusPill(j.exitCode === 0 ? 'ok' : 'err', j.exitCode === 0 ? 'success' : 'error');
                    if (runStatus) runStatus.textContent = j.exitCode === 0 ? 'Finished.' : 'Finished with errors.';
                }
            })
            .catch(() => {
                /**/
            });
    }

    Promise.all([loadPackagePagesMap(), loadBuOptions()]).finally(() => {
        loadTiles();
        loadHistory();
        hydrateFromLastJob();
    });
})();
