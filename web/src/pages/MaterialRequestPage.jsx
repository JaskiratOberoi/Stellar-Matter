import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { BrandMark } from '../components/BrandMark.jsx';
import { unlockMaterialRequestCatalog, submitMaterialRequest } from '../hooks/useMaterialRequests.js';

function emptyLine() {
    return { material_id: '', material_name: '', quantity: '1', unit: 'unit', mode: 'catalog' };
}

export function MaterialRequestPage() {
    const [step, setStep] = useState('code'); // code | form | done
    const [code, setCode] = useState('');
    const [org, setOrg] = useState(null);
    const [materials, setMaterials] = useState([]);
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);
    const [submittedId, setSubmittedId] = useState(null);

    const [requesterName, setRequesterName] = useState('');
    const [requesterContact, setRequesterContact] = useState('');
    const [locationText, setLocationText] = useState('');
    const [neededBy, setNeededBy] = useState('');
    const [notes, setNotes] = useState('');
    const [lines, setLines] = useState([emptyLine()]);

    const materialById = useMemo(() => {
        const m = new Map();
        for (const mat of materials) m.set(mat.id, mat);
        return m;
    }, [materials]);

    async function onUnlock(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            const j = await unlockMaterialRequestCatalog(code.trim());
            setOrg(j.org || null);
            setMaterials(j.materials || []);
            setStep('form');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    function updateLine(idx, patch) {
        setLines((prev) => prev.map((line, i) => (i === idx ? { ...line, ...patch } : line)));
    }

    function addLine() {
        setLines((prev) => [...prev, emptyLine()]);
    }

    function removeLine(idx) {
        setLines((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== idx)));
    }

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            const payloadLines = lines.map((line) => {
                if (line.mode === 'custom') {
                    return {
                        material_name: line.material_name.trim(),
                        quantity: Number(line.quantity),
                        unit: line.unit.trim() || 'unit'
                    };
                }
                const mat = materialById.get(line.material_id);
                return {
                    material_id: line.material_id,
                    quantity: Number(line.quantity),
                    unit: (line.unit || (mat && mat.base_unit) || 'unit').trim()
                };
            });
            const j = await submitMaterialRequest({
                code: code.trim(),
                requester_name: requesterName.trim(),
                requester_contact: requesterContact.trim(),
                location_text: locationText.trim() || null,
                needed_by: neededBy || null,
                notes: notes.trim() || null,
                lines: payloadLines
            });
            setSubmittedId(j.request && j.request.id);
            setStep('done');
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    if (step === 'done') {
        return (
            <main className="login-shell mreq-shell">
                <div className="nexus-card login-card mreq-card">
                    <div className="login-brand">
                        <BrandMark size={40} className="login-brand-mark" />
                        <p className="eyebrow">Materials request</p>
                    </div>
                    <h1 className="wordmark login-title">Request submitted</h1>
                    <p className="muted small login-sub">
                        Thanks{requesterName ? `, ${requesterName}` : ''}. Your request
                        {submittedId ? (
                            <>
                                {' '}
                                (<code className="mreq-code">{submittedId}</code>)
                            </>
                        ) : null}{' '}
                        was sent to {org?.name || 'the organization'} for review.
                    </p>
                    <div className="form-actions mreq-actions">
                        <button
                            type="button"
                            className="btn-primary"
                            onClick={() => {
                                setStep('form');
                                setSubmittedId(null);
                                setLines([emptyLine()]);
                                setNotes('');
                                setNeededBy('');
                                setErr(null);
                            }}
                        >
                            Submit another
                        </button>
                        <Link to="/login" className="chip chip-tool">
                            Staff sign in
                        </Link>
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
                    <h1 className="wordmark login-title">Materials request</h1>
                    <p className="muted small login-sub">
                        Enter the organization access code provided by your admin to open the request form.
                    </p>
                    <form onSubmit={onUnlock} className="login-form">
                        <label>
                            Organization access code
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
                        {err && <p className="login-err">{err}</p>}
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
                    <p className="eyebrow">{org?.name || 'Materials request'}</p>
                </div>
                <h1 className="wordmark login-title">Request materials</h1>
                <p className="muted small login-sub">
                    Pick catalog items or add a custom line. An admin will review before anything is ordered.
                </p>

                <form onSubmit={onSubmit} className="login-form mreq-form">
                    <div className="grid2 sidebar-grid">
                        <label>
                            Your name
                            <input
                                value={requesterName}
                                onChange={(e) => setRequesterName(e.target.value)}
                                required
                                autoFocus
                            />
                        </label>
                        <label>
                            Contact (email or phone)
                            <input
                                value={requesterContact}
                                onChange={(e) => setRequesterContact(e.target.value)}
                                required
                            />
                        </label>
                        <label>
                            Location / lab
                            <input
                                value={locationText}
                                onChange={(e) => setLocationText(e.target.value)}
                                placeholder="e.g. Genomics store"
                            />
                        </label>
                        <label>
                            Needed by
                            <input type="date" value={neededBy} onChange={(e) => setNeededBy(e.target.value)} />
                        </label>
                    </div>

                    <label>
                        Notes
                        <textarea
                            rows={2}
                            value={notes}
                            onChange={(e) => setNotes(e.target.value)}
                            placeholder="Optional context for the reviewer"
                        />
                    </label>

                    <div className="mreq-lines">
                        <div className="row-between mreq-lines-head">
                            <p className="eyebrow-lite">Line items</p>
                            <button type="button" className="chip chip-tool" onClick={addLine}>
                                + Add line
                            </button>
                        </div>
                        {lines.map((line, idx) => {
                            const mat = materialById.get(line.material_id);
                            return (
                                <div key={idx} className="mreq-line nexus-card">
                                    <div className="mreq-line-mode">
                                        <label className="mreq-radio">
                                            <input
                                                type="radio"
                                                name={`mode-${idx}`}
                                                checked={line.mode === 'catalog'}
                                                onChange={() =>
                                                    updateLine(idx, {
                                                        mode: 'catalog',
                                                        material_name: '',
                                                        unit: (mat && mat.base_unit) || line.unit || 'unit'
                                                    })
                                                }
                                            />
                                            Catalog
                                        </label>
                                        <label className="mreq-radio">
                                            <input
                                                type="radio"
                                                name={`mode-${idx}`}
                                                checked={line.mode === 'custom'}
                                                onChange={() =>
                                                    updateLine(idx, {
                                                        mode: 'custom',
                                                        material_id: '',
                                                        unit: line.unit || 'unit'
                                                    })
                                                }
                                            />
                                            Custom
                                        </label>
                                        {lines.length > 1 && (
                                            <button
                                                type="button"
                                                className="chip chip-tool mreq-line-remove"
                                                onClick={() => removeLine(idx)}
                                            >
                                                Remove
                                            </button>
                                        )}
                                    </div>
                                    {line.mode === 'catalog' ? (
                                        <label>
                                            Material
                                            <select
                                                value={line.material_id}
                                                required
                                                onChange={(e) => {
                                                    const next = materialById.get(e.target.value);
                                                    updateLine(idx, {
                                                        material_id: e.target.value,
                                                        unit: (next && next.base_unit) || 'unit'
                                                    });
                                                }}
                                            >
                                                <option value="">— pick a material —</option>
                                                {materials.map((m) => (
                                                    <option key={m.id} value={m.id}>
                                                        {m.name}
                                                        {m.sku ? ` (${m.sku})` : ''}
                                                    </option>
                                                ))}
                                            </select>
                                        </label>
                                    ) : (
                                        <label>
                                            Custom material name
                                            <input
                                                value={line.material_name}
                                                onChange={(e) => updateLine(idx, { material_name: e.target.value })}
                                                required
                                                placeholder="Describe what you need"
                                            />
                                        </label>
                                    )}
                                    <div className="grid2 sidebar-grid">
                                        <label>
                                            Quantity
                                            <input
                                                type="number"
                                                min="0.01"
                                                step="any"
                                                value={line.quantity}
                                                onChange={(e) => updateLine(idx, { quantity: e.target.value })}
                                                required
                                            />
                                        </label>
                                        <label>
                                            Unit
                                            <input
                                                value={line.unit}
                                                onChange={(e) => updateLine(idx, { unit: e.target.value })}
                                                required
                                            />
                                        </label>
                                    </div>
                                </div>
                            );
                        })}
                    </div>

                    {err && <p className="login-err">{err}</p>}
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
                            Change code
                        </button>
                        <button type="submit" className="btn-primary" disabled={busy}>
                            {busy ? 'Submitting…' : 'Submit request'}
                        </button>
                    </div>
                </form>
            </div>
        </main>
    );
}
