import { useEffect, useId, useRef, useState } from 'react';
import { apiFetch } from '../apiClient.js';

/**
 * The LIS appends lab names and lettered sub-units to codes ("UK0204 A PPL &
 * DC"), so a chip shows the bare code unless two picks share it.
 */
function chipText(code, selected) {
    const bare = code.split(/\s+/)[0];
    const clash = selected.some((s) => s.code !== code && s.code.split(/\s+/)[0] === bare);
    return clash ? code : bare;
}

/**
 * Client codes: a type-ahead over the client_locations mirror. There are
 * thousands of codes, so nothing is listed until the operator types; picked
 * codes sit below the field as removable chips and run as one scope.
 *
 * @param {{
 *   selected: { code: string, name: string|null }[],
 *   onAdd: (item: { code: string, name: string|null }) => void,
 *   onRemove: (code: string) => void,
 *   onClear: () => void,
 * }} props
 */
export function ClientCodePicker({ selected, onAdd, onRemove, onClear }) {
    const listId = useId();
    const rootRef = useRef(/** @type {HTMLDivElement | null} */ (null));
    const seqRef = useRef(0);
    const [query, setQuery] = useState('');
    const [open, setOpen] = useState(false);
    const [results, setResults] = useState(/** @type {{ code: string, name: string|null, city: string|null, businessUnit: string|null }[]} */ ([]));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(/** @type {string | null} */ (null));
    const [active, setActive] = useState(0);

    const picked = new Set(selected.map((s) => s.code));

    useEffect(() => {
        const q = query.trim();
        const seq = ++seqRef.current;
        if (!q) {
            setResults([]);
            setLoading(false);
            setError(null);
            return undefined;
        }
        setLoading(true);
        const t = setTimeout(async () => {
            try {
                const r = await apiFetch(`/api/tracer/client-codes/search?q=${encodeURIComponent(q)}`);
                if (seq !== seqRef.current) return;
                setResults(Array.isArray(r.results) ? r.results : []);
                setError(null);
                setActive(0);
            } catch (e) {
                if (seq !== seqRef.current) return;
                setResults([]);
                setError(String(e.message || e));
            } finally {
                if (seq === seqRef.current) setLoading(false);
            }
        }, 200);
        return () => clearTimeout(t);
    }, [query]);

    useEffect(() => {
        if (!open) return undefined;
        function onDoc(e) {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        }
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [open]);

    function pick(item) {
        if (!picked.has(item.code)) onAdd({ code: item.code, name: item.name });
        setQuery('');
        setResults([]);
    }

    function onKeyDown(e) {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((i) => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            // Never submit the tracer form from the search box.
            e.preventDefault();
            if (open && results[active]) pick(results[active]);
        } else if (e.key === 'Escape') {
            setOpen(false);
        } else if (e.key === 'Backspace' && !query && selected.length) {
            onRemove(selected[selected.length - 1].code);
        }
    }

    const showMenu = open && query.trim() !== '';

    return (
        <div className="field-block bu-field-block client-code-field-block">
            <div className="row-between bu-chip-toolbar">
                <span className="eyebrow-lite field-label">Client codes</span>
                <div className="chip-tool-group">
                    <button type="button" className="chip chip-tool" disabled={selected.length === 0} onClick={onClear}>
                        Clear
                    </button>
                </div>
            </div>
            <div className={`inv-combo client-code-combo${showMenu ? ' is-open' : ''}`} ref={rootRef}>
                <input
                    className="inv-combo-input"
                    type="text"
                    value={query}
                    placeholder="Type a client code or lab name, e.g. HLD0519"
                    autoComplete="off"
                    spellCheck={false}
                    role="combobox"
                    aria-label="Search client codes"
                    aria-autocomplete="list"
                    aria-expanded={showMenu ? 'true' : 'false'}
                    aria-controls={listId}
                    aria-activedescendant={showMenu && results[active] ? `${listId}-${active}` : undefined}
                    onChange={(e) => {
                        setQuery(e.target.value);
                        setOpen(true);
                    }}
                    onFocus={() => setOpen(true)}
                    onKeyDown={onKeyDown}
                />
                {showMenu && (
                    <div className="inv-combo-menu" role="listbox" id={listId} aria-label="Matching client codes">
                        {results.map((r, i) => {
                            const already = picked.has(r.code);
                            return (
                                <button
                                    key={r.code}
                                    id={`${listId}-${i}`}
                                    type="button"
                                    tabIndex={-1}
                                    role="option"
                                    aria-selected={i === active}
                                    className={`inv-combo-option client-code-option${i === active ? ' is-active' : ''}`}
                                    onMouseEnter={() => setActive(i)}
                                    onClick={() => pick(r)}
                                >
                                    <span className="client-code-option-main">
                                        <span className="client-code-option-code">{r.code.split(/\s+/)[0]}</span>
                                        <span className="client-code-option-name">{r.name || r.code}</span>
                                    </span>
                                    <span className="inv-combo-kind">
                                        {already ? 'added' : [r.businessUnit, r.city].filter(Boolean).join(' · ')}
                                    </span>
                                </button>
                            );
                        })}
                        {!loading && !error && results.length === 0 && (
                            <p className="client-code-menu-msg muted small">No active client matches &ldquo;{query.trim()}&rdquo;.</p>
                        )}
                        {loading && results.length === 0 && <p className="client-code-menu-msg muted small">Searching…</p>}
                        {error && <p className="client-code-menu-msg muted small">Search failed ({error}).</p>}
                    </div>
                )}
            </div>
            {selected.length > 0 && (
                <div className="chip-grid client-code-picked" role="list" aria-label="Selected client codes">
                    {selected.map((s) => (
                        <span key={s.code} className="chip client-code-chip" role="listitem" title={s.name || s.code}>
                            {chipText(s.code, selected)}
                            <button
                                type="button"
                                className="client-code-chip-x"
                                aria-label={`Remove ${s.code}`}
                                onClick={() => onRemove(s.code)}
                            >
                                ×
                            </button>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
