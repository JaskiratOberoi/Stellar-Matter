import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark.jsx';
import { unlockMaterialRequestCatalog, submitMaterialRequest } from '../hooks/useMaterialRequests.js';

// Who is asking, kept on this device so a repeat requester doesn't retype it.
const LS_REQUESTER = 'stellar-matter.request.requester';

function readRequester() {
    try {
        const v = JSON.parse(localStorage.getItem(LS_REQUESTER) || 'null');
        return v && typeof v === 'object' ? v : {};
    } catch {
        return {};
    }
}

/**
 * A YYYY-MM-DD as the calendar day it names, built from its parts so no
 * timezone can move it: parsing the string as a timestamp read it as UTC
 * midnight in some browsers and printed the day before in India.
 */
function dayLabel(v) {
    const [y, m, d] = String(v || '').slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return String(v || '');
    return new Date(y, m - 1, d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let lineSeq = 0;
function emptyLine() {
    lineSeq += 1;
    // material_id set = a catalog item; otherwise material_name is free text.
    return { key: `l${lineSeq}`, material_id: '', material_name: '', quantity: '1', unit: '' };
}

/**
 * One box per line: type to search the catalog, or keep your own wording as
 * an item that isn't in the catalog. Replaces a Catalog/Custom switch.
 */
function ItemPicker({ line, materials, onPick }) {
    const rootRef = useRef(null);
    const [open, setOpen] = useState(false);
    const [q, setQ] = useState(line.material_id ? '' : line.material_name);
    const [active, setActive] = useState(0);
    const picked = line.material_id ? materials.find((m) => m.id === line.material_id) : null;

    const matches = useMemo(() => {
        const s = q.trim().toLowerCase();
        const list = s ? materials.filter((m) => m.name.toLowerCase().includes(s)) : materials;
        return list.slice(0, 30);
    }, [q, materials]);
    const exact = matches.some((m) => m.name.toLowerCase() === q.trim().toLowerCase());
    const options = [...matches.map((m) => ({ m })), ...(q.trim() && !exact ? [{ custom: q.trim() }] : [])];

    useEffect(() => setActive(0), [q]);
    useEffect(() => {
        if (!open) return undefined;
        const onDown = (e) => {
            if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onDown);
        return () => document.removeEventListener('pointerdown', onDown);
    }, [open]);

    const choose = (o) => {
        if (o.m) {
            onPick({ material_id: o.m.id, material_name: o.m.name, unit: o.m.base_unit || 'unit' });
            setQ('');
        } else {
            onPick({ material_id: '', material_name: o.custom, unit: line.unit || '' });
            setQ(o.custom);
        }
        setOpen(false);
    };

    const shown = open ? q : picked ? picked.name : q;
    return (
        <div className={`inv-combo mreq-item${open ? ' is-open' : ''}`} ref={rootRef}>
            <input
                className="inv-combo-input mreq-item-input"
                value={shown}
                placeholder="Search the catalog or describe the item"
                aria-label="Item"
                role="combobox"
                aria-expanded={open ? 'true' : 'false'}
                autoComplete="off"
                onFocus={() => {
                    setOpen(true);
                    if (picked) setQ('');
                }}
                onChange={(e) => {
                    setQ(e.target.value);
                    setOpen(true);
                    if (line.material_id) onPick({ material_id: '', material_name: e.target.value, unit: '' });
                    else onPick({ material_name: e.target.value });
                }}
                onKeyDown={(e) => {
                    if (e.key === 'ArrowDown') {
                        e.preventDefault();
                        setActive((a) => Math.min(a + 1, options.length - 1));
                    } else if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        setActive((a) => Math.max(a - 1, 0));
                    } else if (e.key === 'Enter' && open && options[active]) {
                        e.preventDefault();
                        choose(options[active]);
                    } else if (e.key === 'Escape') {
                        setOpen(false);
                    }
                }}
            />
            {open && options.length > 0 && (
                <div className="inv-combo-menu" role="listbox">
                    {options.map((o, i) => (
                        <button
                            key={o.m ? o.m.id : 'custom'}
                            type="button"
                            role="option"
                            aria-selected={i === active ? 'true' : 'false'}
                            className={`inv-combo-option${i === active ? ' is-hl' : ''}${o.custom ? ' inv-combo-add' : ''}`}
                            onMouseEnter={() => setActive(i)}
                            onClick={() => choose(o)}
                        >
                            {o.m ? (
                                <>
                                    <span>{o.m.name}</span>
                                    <span className="inv-combo-kind">{o.m.base_unit}</span>
                                </>
                            ) : (
                                <>
                                    <span>Use “{o.custom}”</span>
                                    <span className="inv-combo-new-badge">not in catalog</span>
                                </>
                            )}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export function MaterialRequestPage() {
    const remembered = useMemo(readRequester, []);
    const [step, setStep] = useState('code'); // code | form | done
    const [code, setCode] = useState('');
    const [org, setOrg] = useState(null);
    const [materials, setMaterials] = useState([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const [sent, setSent] = useState(null);

    const [requesterName, setRequesterName] = useState(remembered.name || '');
    const [requesterContact, setRequesterContact] = useState(remembered.contact || '');
    const [locationText, setLocationText] = useState(remembered.location || '');
    const [neededBy, setNeededBy] = useState('');
    const [notes, setNotes] = useState('');
    const [lines, setLines] = useState(() => [emptyLine()]);

    async function unlock(value) {
        setBusy(true);
        setErr(null);
        try {
            const j = await unlockMaterialRequestCatalog(value.trim());
            setOrg(j.org || null);
            setMaterials((j.materials || []).slice().sort((a, b) => a.name.localeCompare(b.name)));
            setStep('form');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    async function onUnlock(e) {
        e.preventDefault();
        await unlock(code);
    }

    // A quick link carries the code: /request?code=XXXXXXXXXX opens the form
    // straight away, for a QR at a site or a bookmark on a shared desk. The
    // code is dropped from the address bar once it has been used.
    const [searchParams, setSearchParams] = useSearchParams();
    const linkCode = (searchParams.get('code') || '').trim().toUpperCase();
    useEffect(() => {
        if (!linkCode || step !== 'code' || busy) return;
        setCode(linkCode);
        unlock(linkCode).then(() => setSearchParams({}, { replace: true }));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [linkCode]);

    const updateLine = (key, patch) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
    const removeLine = (key) => setLines((prev) => (prev.length <= 1 ? prev : prev.filter((l) => l.key !== key)));

    const filled = lines.filter((l) => (l.material_id || l.material_name.trim()) && Number(l.quantity) > 0);
    const incomplete = lines.some((l) => (l.material_id || l.material_name.trim()) && !(Number(l.quantity) > 0));

    async function onSubmit(e) {
        e.preventDefault();
        setErr(null);
        if (!filled.length) return setErr('Add at least one item with a quantity.');
        if (incomplete) return setErr('Every item needs a quantity above 0.');
        const customNoUnit = filled.find((l) => !l.material_id && !l.unit.trim());
        if (customNoUnit) return setErr(`Say what unit “${customNoUnit.material_name.trim()}” is counted in (box, piece…).`);
        setBusy(true);
        try {
            const payloadLines = filled.map((l) =>
                l.material_id
                    ? { material_id: l.material_id, quantity: Number(l.quantity), unit: l.unit || 'unit' }
                    : { material_name: l.material_name.trim(), quantity: Number(l.quantity), unit: l.unit.trim() }
            );
            const j = await submitMaterialRequest({
                code: code.trim(),
                requester_name: requesterName.trim(),
                requester_contact: requesterContact.trim(),
                location_text: locationText.trim() || null,
                needed_by: neededBy || null,
                notes: notes.trim() || null,
                lines: payloadLines
            });
            try {
                localStorage.setItem(
                    LS_REQUESTER,
                    JSON.stringify({ name: requesterName.trim(), contact: requesterContact.trim(), location: locationText.trim() })
                );
            } catch {
                /* storage blocked: nothing remembered */
            }
            setSent({
                id: j.request && j.request.id,
                items: filled.map((l) => ({
                    name: l.material_id ? (materials.find((m) => m.id === l.material_id) || {}).name || l.material_name : l.material_name.trim(),
                    qty: Number(l.quantity),
                    unit: l.unit
                })),
                neededBy
            });
            setStep('done');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    if (step === 'done' && sent) {
        return (
            <main className="login-shell mreq-shell">
                <div className="nexus-card login-card mreq-card">
                    <div className="login-brand">
                        <BrandMark size={40} className="login-brand-mark" />
                        <p className="eyebrow">{org?.name || 'Material request'}</p>
                    </div>
                    <h1 className="wordmark login-title">Request sent</h1>
                    <p className="muted small login-sub">
                        Thanks{requesterName ? `, ${requesterName.split(' ')[0]}` : ''}. An admin will review it
                        {sent.neededBy ? ` before ${dayLabel(sent.neededBy)}` : ''} and
                        contact you at {requesterContact} if anything is unclear.
                    </p>
                    <ul className="mreq-sent">
                        {sent.items.map((it, i) => (
                            <li key={i}>
                                <span>{it.name}</span>
                                <span className="mreq-sent-qty">
                                    {it.qty.toLocaleString()} {it.unit}
                                </span>
                            </li>
                        ))}
                    </ul>
                    {sent.id && <p className="muted small">Reference: <code className="mreq-code">{sent.id}</code></p>}
                    <div className="form-actions mreq-actions">
                        <button
                            type="button"
                            className="btn-primary"
                            onClick={() => {
                                setStep('form');
                                setSent(null);
                                setLines([emptyLine()]);
                                setNotes('');
                                setNeededBy('');
                                setErr(null);
                            }}
                        >
                            Send another request
                        </button>
                    </div>
                </div>
            </main>
        );
    }

    if (step === 'code') {
        return (
            <main className="login-shell mreq-shell">
                <div className="nexus-card login-card mreq-card">
                    <div className="login-brand">
                        <BrandMark size={40} className="login-brand-mark" />
                        <p className="eyebrow">Stellar Matter</p>
                    </div>
                    <h1 className="wordmark login-title">Request materials</h1>
                    <p className="muted small login-sub">
                        Enter the access code your organisation gave you to open the request form.
                    </p>
                    <form onSubmit={onUnlock} className="login-form">
                        <label>
                            Access code
                            <input
                                type="text"
                                autoComplete="off"
                                value={code}
                                onChange={(e) => setCode(e.target.value.toUpperCase())}
                                placeholder="XXXXXXXXXX"
                                required
                                autoFocus
                                spellCheck={false}
                            />
                        </label>
                        {err && <p className="login-err" role="alert">{err}</p>}
                        <button type="submit" className="btn-primary" disabled={busy || code.trim().length < 6}>
                            {busy ? 'Checking…' : 'Continue'}
                        </button>
                    </form>
                    <p className="muted small mreq-foot">
                        Staff? <Link to="/login">Sign in</Link>
                    </p>
                </div>
            </main>
        );
    }

    return (
        <main className="login-shell mreq-shell mreq-shell--wide">
            <div className="nexus-card login-card mreq-card mreq-card--wide">
                <div className="login-brand">
                    <BrandMark size={40} className="login-brand-mark" />
                    <p className="eyebrow">{org?.name || 'Material request'}</p>
                </div>
                <h1 className="wordmark login-title">Request materials</h1>
                <p className="muted small login-sub">
                    Add what you need. An admin reviews every request before anything is sent.
                </p>

                <form onSubmit={onSubmit} className="login-form mreq-form">
                    <fieldset className="mreq-who-fields">
                        <legend className="eyebrow-lite">Your details</legend>
                        <div className="grid2 sidebar-grid">
                            <label>
                                Your name
                                <input
                                    value={requesterName}
                                    onChange={(e) => setRequesterName(e.target.value)}
                                    autoComplete="name"
                                    required
                                    autoFocus={!requesterName}
                                />
                            </label>
                            <label>
                                Phone or email
                                <input
                                    value={requesterContact}
                                    onChange={(e) => setRequesterContact(e.target.value)}
                                    autoComplete="tel"
                                    required
                                />
                            </label>
                            <label>
                                Site or lab
                                <input
                                    value={locationText}
                                    onChange={(e) => setLocationText(e.target.value)}
                                    placeholder="e.g. Karnal collection centre"
                                />
                            </label>
                            <label>
                                Needed by
                                <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
                            </label>
                        </div>
                    </fieldset>

                    <fieldset className="mreq-items-fields">
                        <legend className="eyebrow-lite">Items</legend>
                        <div className="mreq-item-rows">
                            {lines.map((line) => {
                                const isCatalog = Boolean(line.material_id);
                                return (
                                    <div key={line.key} className="mreq-item-row">
                                        <ItemPicker
                                            line={line}
                                            materials={materials}
                                            onPick={(patch) => updateLine(line.key, patch)}
                                        />
                                        <input
                                            className="mreq-qty"
                                            type="number"
                                            inputMode="numeric"
                                            min="1"
                                            step="1"
                                            aria-label="Quantity"
                                            value={line.quantity}
                                            onChange={(e) => updateLine(line.key, { quantity: e.target.value })}
                                        />
                                        {isCatalog ? (
                                            <span className="mreq-unit" title="Unit from the catalog">
                                                {line.unit}
                                            </span>
                                        ) : (
                                            <input
                                                className="mreq-unit-input"
                                                aria-label="Unit"
                                                placeholder="unit"
                                                value={line.unit}
                                                onChange={(e) => updateLine(line.key, { unit: e.target.value })}
                                            />
                                        )}
                                        <button
                                            type="button"
                                            className="mreq-remove"
                                            aria-label="Remove item"
                                            disabled={lines.length <= 1}
                                            onClick={() => removeLine(line.key)}
                                        >
                                            ×
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                        <button type="button" className="chip chip-tool mreq-add" onClick={() => setLines((p) => [...p, emptyLine()])}>
                            + Add another item
                        </button>
                    </fieldset>

                    <label>
                        Anything else?
                        <textarea
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Optional note for the reviewer"
                        />
                    </label>

                    {err && <p className="login-err" role="alert">{err}</p>}
                    <div className="form-actions mreq-actions">
                        <button
                            type="button"
                            className="chip chip-tool"
                            disabled={busy}
                            onClick={() => {
                                setStep('code');
                                setErr(null);
                            }}
                        >
                            Use a different code
                        </button>
                        <button type="submit" className="btn-primary" disabled={busy || !filled.length}>
                            {busy ? 'Sending…' : `Send request${filled.length ? ` (${filled.length} item${filled.length === 1 ? '' : 's'})` : ''}`}
                        </button>
                    </div>
                </form>
            </div>
        </main>
    );
}
