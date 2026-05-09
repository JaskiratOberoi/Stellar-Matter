import { useEffect, useState } from 'react';
import { LS_SOURCE, readString, writeString } from '../lib/storage.js';
import { BuChips } from './BuChips.jsx';
import { DateChips } from './DateChips.jsx';

const BLANK_FORM = {
    source: 'scrape',
    fromDate: '',
    toDate: '',
    fromHour: '',
    toHour: '',
    bu: '',
    status: '',
    testCode: '',
    clientCode: '',
    sid: '',
    vailId: '',
    pid: '',
    deptNo: '',
    openSid: '',
    outDir: '',
    scrapePackages: false,
    dryRun: false,
    headless: false,
    skipRegionalBadge: false,
    noScreenshots: false
};

export function RunSidebar({
    collapsed,
    buOptions,
    buSelected,
    buActions,
    busy,
    mode,
    sqlOnlyLocked,
    onSubmit,
    onClearLedger
}) {
    // Urine-container mode auto-pins testCode = cp004 OR mb034 (the union is
    // executed server-side by lib/sql-source.js). When the user is on the
    // Urine Containers tab we lock the source to SQL (the only source that
    // can take a testCode) and replace the free-text Test code input with a
    // read-only chip so it's clear which assays drive the count.
    //
    // sqlOnlyLocked: users with app role 'admin' — Data source radios are
    // hidden; SQL is the only allowed source (enforced on POST /api/run too).
    const isUrine = mode === 'urine_containers';
    const lockedSql = !!sqlOnlyLocked;
    const [form, setForm] = useState(() => ({
        ...BLANK_FORM,
        source:
            isUrine || lockedSql
                ? 'sql'
                : readString(LS_SOURCE, 'scrape') === 'sql'
                  ? 'sql'
                  : 'scrape'
    }));

    useEffect(() => {
        if ((isUrine || lockedSql) && form.source !== 'sql') {
            setForm((prev) => ({ ...prev, source: 'sql' }));
        }
    }, [isUrine, lockedSql, form.source]);

    useEffect(() => {
        if (!isUrine && !lockedSql) writeString(LS_SOURCE, form.source);
    }, [form.source, isUrine, lockedSql]);

    function update(name, value) {
        setForm((prev) => ({ ...prev, [name]: value }));
    }

    function handleSubmit(e) {
        e.preventDefault();
        const body = {};
        for (const [k, v] of Object.entries(form)) {
            if (typeof v === 'boolean') {
                body[k] = v;
            } else if (v !== '' && v != null) {
                body[k] = v;
            }
        }
        if (form.fromHour !== '') body.fromHour = Number(form.fromHour);
        if (form.toHour !== '') body.toHour = Number(form.toHour);
        body.source = form.source;
        if (isUrine) {
            body.mode = 'urine_containers';
            body.source = 'sql';
            // Strip any stale free-text testCode — server pins cp004+mb034 from the mode flag.
            delete body.testCode;
        } else if (lockedSql) {
            body.source = 'sql';
        }
        if (body.source === 'sql' && buSelected.size > 0) {
            body.businessUnits = [...buSelected];
            if (body.businessUnits.length === 1 && !body.bu) body.bu = body.businessUnits[0];
        }
        onSubmit(body);
    }

    const wantSql = form.source === 'sql';
    const showScrapeOnly = !wantSql && !isUrine && !lockedSql;
    const sourceHint = isUrine
        ? 'Urine container mode is locked to SQL. Each run fires two parallel Listec calls (cp004 + mb034) and unions the SIDs.'
        : wantSql
        ? 'Calls the Listec service (LISTEC_API_BASE_URL, default http://127.0.0.1:3100) — multi-BU runs allowed.'
        : 'Drives the LIS web grid via headless Chromium. Multi-BU runs require SQL.';

    return (
        <aside className={`run-sidebar${collapsed ? ' collapsed-visual' : ''}`} aria-labelledby="sidebar-title">
            <div className="sidebar-inner">
                <h2 id="sidebar-title" className="sidebar-heading eyebrow">
                    Run
                </h2>
                <form onSubmit={handleSubmit}>
                    <div className="sidebar-groups">
                        <fieldset className="source-picker nexus-card source-picker-card" aria-label="Data source">
                            <legend className="source-picker-legend eyebrow-lite">Data source</legend>
                            {lockedSql ? (
                                <>
                                    <p className="muted small source-sql-readonly">
                                        Data source: <strong>SQL (Listec)</strong>
                                    </p>
                                    {isUrine && (
                                        <p className="muted small source-hint urine-pin-banner">
                                            <span className="chip chip-tool urine-pin-chip">Pinned: cp004 OR mb034</span>
                                        </p>
                                    )}
                                    <p className="muted small source-hint">{sourceHint}</p>
                                </>
                            ) : (
                                <>
                                    <label>
                                        <input
                                            type="radio"
                                            name="source"
                                            value="scrape"
                                            checked={form.source === 'scrape'}
                                            disabled={isUrine}
                                            onChange={() => update('source', 'scrape')}
                                        />{' '}
                                        Web scrape
                                    </label>
                                    <label>
                                        <input
                                            type="radio"
                                            name="source"
                                            value="sql"
                                            checked={form.source === 'sql'}
                                            disabled={isUrine}
                                            onChange={() => update('source', 'sql')}
                                        />{' '}
                                        SQL (Listec)
                                    </label>
                                    {isUrine && (
                                        <p className="muted small source-hint urine-pin-banner">
                                            <span className="chip chip-tool urine-pin-chip">Pinned: cp004 OR mb034</span>
                                        </p>
                                    )}
                                    <p className="muted small source-hint">{sourceHint}</p>
                                </>
                            )}
                        </fieldset>

                        <section className="nexus-card section-card">
                            <h3 className="section-card-title eyebrow">Filters</h3>
                            <div className="field-block">
                                <span className="eyebrow-lite field-label">Date quick picks</span>
                                <DateChips
                                    fromDate={form.fromDate}
                                    toDate={form.toDate}
                                    onPick={({ from, to }) => setForm((p) => ({ ...p, fromDate: from, toDate: to }))}
                                />
                            </div>
                            <div className="grid2 sidebar-grid">
                                <label>
                                    From date{' '}
                                    <input
                                        type="text"
                                        placeholder="DD/MM/YYYY"
                                        value={form.fromDate}
                                        onChange={(e) => update('fromDate', e.target.value)}
                                    />
                                </label>
                                <label>
                                    To date{' '}
                                    <input
                                        type="text"
                                        placeholder="DD/MM/YYYY"
                                        value={form.toDate}
                                        onChange={(e) => update('toDate', e.target.value)}
                                    />
                                </label>
                                <label>
                                    From hour{' '}
                                    <input
                                        type="number"
                                        min="0"
                                        max="23"
                                        value={form.fromHour}
                                        onChange={(e) => update('fromHour', e.target.value)}
                                    />
                                </label>
                                <label>
                                    To hour{' '}
                                    <input
                                        type="number"
                                        min="0"
                                        max="23"
                                        value={form.toHour}
                                        onChange={(e) => update('toHour', e.target.value)}
                                    />
                                </label>
                            </div>
                            <BuChips
                                source={form.source}
                                options={buOptions.options}
                                selected={buSelected}
                                onToggle={buActions.toggle}
                                onSelectAll={buActions.selectAll}
                                onClear={buActions.clear}
                                lookupError={buOptions.error}
                                freeTextField={
                                    <input
                                        type="text"
                                        placeholder="ROHTAK or id"
                                        autoComplete="off"
                                        value={form.bu}
                                        onChange={(e) => update('bu', e.target.value)}
                                    />
                                }
                            />
                        </section>

                        <details open className="sidebar-detail">
                            <summary>Core filters</summary>
                            <div className="grid2 sidebar-grid">
                                <label>
                                    Status{' '}
                                    <input
                                        type="text"
                                        placeholder="--All-- or Partially Tested"
                                        value={form.status}
                                        onChange={(e) => update('status', e.target.value)}
                                    />
                                </label>
                                <label>
                                    Test code{' '}
                                    {isUrine ? (
                                        <span
                                            className="chip chip-tool urine-pin-chip"
                                            title="Locked by Urine Containers tab — server fires cp004 + mb034 in parallel"
                                        >
                                            cp004 OR mb034
                                        </span>
                                    ) : (
                                        <input
                                            type="text"
                                            value={form.testCode}
                                            onChange={(e) => update('testCode', e.target.value)}
                                        />
                                    )}
                                </label>
                            </div>
                        </details>
                        <details open className="sidebar-detail">
                            <summary>IDs</summary>
                            <div className="grid2 sidebar-grid">
                                <label>
                                    Client code{' '}
                                    <input type="text" value={form.clientCode} onChange={(e) => update('clientCode', e.target.value)} />
                                </label>
                                <label>
                                    SID filter <input type="text" value={form.sid} onChange={(e) => update('sid', e.target.value)} />
                                </label>
                                <label>
                                    Vail id <input type="text" value={form.vailId} onChange={(e) => update('vailId', e.target.value)} />
                                </label>
                                <label>
                                    PID <input type="text" value={form.pid} onChange={(e) => update('pid', e.target.value)} />
                                </label>
                                <label>
                                    Dept no <input type="text" value={form.deptNo} onChange={(e) => update('deptNo', e.target.value)} />
                                </label>
                                {showScrapeOnly && (
                                    <label>
                                        <span>Open SID (modal)</span>{' '}
                                        <input
                                            type="text"
                                            value={form.openSid}
                                            disabled={form.scrapePackages}
                                            onChange={(e) => update('openSid', e.target.value)}
                                        />
                                    </label>
                                )}
                            </div>
                        </details>
                        <details open className="sidebar-detail">
                            <summary>Output &amp; modes</summary>
                            <div className="sidebar-grid single">
                                <label>
                                    Out dir{' '}
                                    <input
                                        type="text"
                                        placeholder="./out"
                                        value={form.outDir}
                                        onChange={(e) => update('outDir', e.target.value)}
                                    />
                                </label>
                            </div>
                            <fieldset className="checks">
                                {showScrapeOnly && (
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={form.scrapePackages}
                                            onChange={(e) => update('scrapePackages', e.target.checked)}
                                        />{' '}
                                        Package scrape
                                    </label>
                                )}
                                <label>
                                    <input
                                        type="checkbox"
                                        checked={form.dryRun}
                                        onChange={(e) => update('dryRun', e.target.checked)}
                                    />{' '}
                                    Dry run
                                </label>
                                {showScrapeOnly && (
                                    <>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={form.headless}
                                                onChange={(e) => update('headless', e.target.checked)}
                                            />{' '}
                                            Headless
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={form.skipRegionalBadge}
                                                onChange={(e) => update('skipRegionalBadge', e.target.checked)}
                                            />{' '}
                                            Skip regional badge
                                        </label>
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={form.noScreenshots}
                                                onChange={(e) => update('noScreenshots', e.target.checked)}
                                            />{' '}
                                            No screenshots
                                        </label>
                                    </>
                                )}
                            </fieldset>
                        </details>
                    </div>
                    <div className="form-actions">
                        <button type="submit" className="btn-primary" disabled={busy}>
                            {isUrine ? 'Run urine container count' : 'Run'}
                        </button>
                        <button type="button" className="btn-secondary chip-like" onClick={onClearLedger}>
                            Clear ledger
                        </button>
                    </div>
                </form>
            </div>
        </aside>
    );
}
