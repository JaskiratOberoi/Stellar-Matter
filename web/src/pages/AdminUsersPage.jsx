import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../apiClient.js';

const ROLES = ['operator', 'viewer'];

export function AdminUsersPage() {
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);

    const reload = useCallback(async () => {
        setLoading(true);
        setErr(null);
        try {
            const r = await apiFetch('/api/admin/users');
            if (!r.ok) {
                const j = await r.json().catch(() => ({}));
                throw new Error(j.error || `HTTP ${r.status}`);
            }
            const j = await r.json();
            setUsers(j.users || []);
        } catch (e) {
            setErr(String(e.message || e));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        reload();
    }, [reload]);

    return (
        <main className="admin-shell">
            <header className="admin-header row-between">
                <div>
                    <p className="eyebrow">Admin</p>
                    <h1 className="wordmark">Users</h1>
                    <p className="muted small">Operators can run jobs; viewers can browse tiles only.</p>
                </div>
                <div className="admin-actions">
                    <Link to="/" className="chip chip-tool">
                        ← Back to dashboard
                    </Link>
                    <Link to="/admin/audit-log" className="chip chip-tool">
                        Audit log
                    </Link>
                    <button type="button" className="btn-primary" onClick={() => setCreateOpen((v) => !v)}>
                        {createOpen ? 'Cancel' : 'New user'}
                    </button>
                </div>
            </header>

            {createOpen && <CreateUserForm onCreated={() => { setCreateOpen(false); reload(); }} />}

            {err && <div className="results-error nexus-card">{err}</div>}
            {loading ? (
                <p className="muted">Loading…</p>
            ) : (
                <table className="packages admin-users-table">
                    <thead>
                        <tr>
                            <th>Username</th>
                            <th>Display name</th>
                            <th>Role</th>
                            <th>Active</th>
                            <th>Created</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((u) => (
                            <UserRow key={u.id} user={u} onChanged={reload} />
                        ))}
                        {!users.length && (
                            <tr>
                                <td colSpan={6} className="muted">No users yet.</td>
                            </tr>
                        )}
                    </tbody>
                </table>
            )}
        </main>
    );
}

function CreateUserForm({ onCreated }) {
    const [username, setUsername] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [password, setPassword] = useState('');
    const [role, setRole] = useState('operator');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            const r = await apiFetch('/api/admin/users', {
                method: 'POST',
                body: JSON.stringify({ username, display_name: displayName, password, role })
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onCreated();
        } catch (e2) {
            setErr(String(e2.message || e2));
        } finally {
            setBusy(false);
        }
    }

    return (
        <form className="nexus-card admin-create" onSubmit={onSubmit}>
            <h2 className="card-title-demoted">Create user</h2>
            <div className="grid2 sidebar-grid">
                <label>
                    Username <input value={username} onChange={(e) => setUsername(e.target.value)} required />
                </label>
                <label>
                    Display name <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                </label>
                <label>
                    Password (min 8){' '}
                    <input
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        minLength={8}
                        required
                    />
                </label>
                <label>
                    Role
                    <select value={role} onChange={(e) => setRole(e.target.value)}>
                        {ROLES.map((r) => (
                            <option key={r} value={r}>
                                {r}
                            </option>
                        ))}
                    </select>
                </label>
            </div>
            {err && <p className="login-err">{err}</p>}
            <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? 'Creating…' : 'Create user'}
                </button>
            </div>
        </form>
    );
}

function UserRow({ user, onChanged }) {
    const [busy, setBusy] = useState(false);
    const [pwOpen, setPwOpen] = useState(false);
    const [pw, setPw] = useState('');

    async function patch(body) {
        setBusy(true);
        try {
            const r = await apiFetch(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify(body)
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onChanged();
        } catch (e) {
            window.alert(String(e.message || e));
        } finally {
            setBusy(false);
        }
    }

    async function remove() {
        if (!window.confirm(`Delete user ${user.username}? This cannot be undone.`)) return;
        setBusy(true);
        try {
            const r = await apiFetch(`/api/admin/users/${user.id}`, { method: 'DELETE' });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onChanged();
        } catch (e) {
            window.alert(String(e.message || e));
        } finally {
            setBusy(false);
        }
    }

    async function resetPassword(e) {
        e.preventDefault();
        if (pw.length < 8) {
            window.alert('Password must be at least 8 characters.');
            return;
        }
        await patch({ password: pw });
        setPwOpen(false);
        setPw('');
    }

    return (
        <>
            <tr>
                <td className="label">{user.username}</td>
                <td className="label">{user.display_name}</td>
                <td>
                    <span className={`env-chip ${user.role === 'super_admin' ? 'env-big' : 'env-small'}`}>
                        {user.role}
                    </span>
                </td>
                <td>{user.active ? '✓' : '—'}</td>
                <td className="muted small">{new Date(user.created_at).toLocaleString()}</td>
                <td className="admin-row-actions">
                    {user.role !== 'super_admin' && (
                        <>
                            <button
                                type="button"
                                className="chip chip-tool"
                                disabled={busy}
                                onClick={() => patch({ active: !user.active })}
                            >
                                {user.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button
                                type="button"
                                className="chip chip-tool"
                                disabled={busy}
                                onClick={() => setPwOpen((v) => !v)}
                            >
                                Reset password
                            </button>
                            <button
                                type="button"
                                className="chip chip-tool"
                                disabled={busy}
                                onClick={remove}
                            >
                                Delete
                            </button>
                        </>
                    )}
                </td>
            </tr>
            {pwOpen && (
                <tr>
                    <td colSpan={6}>
                        <form className="admin-pw-form" onSubmit={resetPassword}>
                            <input
                                type="password"
                                placeholder="New password (min 8)"
                                value={pw}
                                onChange={(e) => setPw(e.target.value)}
                                minLength={8}
                                required
                            />
                            <button type="submit" className="btn-primary" disabled={busy || pw.length < 8}>
                                Set new password
                            </button>
                        </form>
                    </td>
                </tr>
            )}
        </>
    );
}
