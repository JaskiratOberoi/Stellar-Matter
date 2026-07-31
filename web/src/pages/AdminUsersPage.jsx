import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../apiClient.js';
import { useAuth } from '../contexts/AuthContext.jsx';

const ROLES = ['operator', 'admin', 'viewer'];

export function AdminUsersPage() {
    const { user: currentUser } = useAuth();
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [notice, setNotice] = useState(null);
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
                    <p className="muted small">
                        Operators can run jobs (web or SQL).{' '}
                        <strong>admin</strong> users run SQL-only (no web scrape picker).{' '}
                        Viewers browse tiles only; they cannot start runs.
                    </p>
                </div>
                <div className="admin-actions">
                    <Link to="/" className="chip chip-tool">
                        ← Back to Tracer
                    </Link>
                    <Link to="/admin/orgs" className="chip chip-tool">
                        Orgs
                    </Link>
                    <Link to="/admin/audit-log" className="chip chip-tool">
                        Audit log
                    </Link>
                    <button type="button" className="btn-primary" onClick={() => setCreateOpen((v) => !v)}>
                        {createOpen ? 'Cancel' : 'New user'}
                    </button>
                </div>
            </header>

            {createOpen && (
                <CreateUserForm
                    onCreated={(username) => {
                        setCreateOpen(false);
                        setNotice({ kind: 'success', text: `Created ${username}.` });
                        reload();
                    }}
                />
            )}

            {err && <div className="results-error nexus-card">{err}</div>}
            {notice && (
                <p className={`admin-notice ${notice.kind === 'error' ? 'is-error' : 'is-success'}`} role="status">
                    {notice.text}
                </p>
            )}
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
                            <UserRow
                                key={u.id}
                                user={u}
                                isSelf={!!currentUser && currentUser.id === u.id}
                                onChanged={reload}
                                onNotice={setNotice}
                            />
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
            onCreated(username);
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

function UserRow({ user, isSelf, onChanged, onNotice }) {
    const [busy, setBusy] = useState(false);
    const [editOpen, setEditOpen] = useState(false);
    const isSuperAdmin = user.role === 'super_admin';

    async function patch(body, successText) {
        setBusy(true);
        try {
            const r = await apiFetch(`/api/admin/users/${user.id}`, {
                method: 'PATCH',
                body: JSON.stringify(body)
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onNotice({ kind: 'success', text: successText });
            onChanged();
            return true;
        } catch (e) {
            onNotice({ kind: 'error', text: String(e.message || e) });
            return false;
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
            onNotice({ kind: 'success', text: `Deleted ${user.username}.` });
            onChanged();
        } catch (e) {
            onNotice({ kind: 'error', text: String(e.message || e) });
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <tr className={editOpen ? 'is-editing' : undefined}>
                <td className="label">{user.username}</td>
                <td className="label">{user.display_name}</td>
                <td>
                    <span className={`env-chip ${isSuperAdmin ? 'env-big' : 'env-small'}`}>{user.role}</span>
                </td>
                <td>{user.active ? '✓' : '—'}</td>
                <td className="muted small">{new Date(user.created_at).toLocaleString()}</td>
                <td className="admin-row-actions">
                    <div className="admin-row-actions-inner">
                        <button
                            type="button"
                            className="chip chip-tool"
                            disabled={busy}
                            aria-expanded={editOpen}
                            onClick={() => setEditOpen((v) => !v)}
                        >
                            {editOpen ? 'Close' : 'Edit'}
                        </button>
                        {isSuperAdmin ? (
                            <span className="admin-row-note" title="A super_admin cannot be deactivated or deleted here.">
                                Protected
                            </span>
                        ) : (
                            <>
                                <button
                                    type="button"
                                    className="chip chip-tool"
                                    disabled={busy || isSelf}
                                    title={isSelf ? 'You cannot deactivate your own account.' : undefined}
                                    onClick={() =>
                                        patch(
                                            { active: !user.active },
                                            `${user.active ? 'Deactivated' : 'Activated'} ${user.username}.`
                                        )
                                    }
                                >
                                    {user.active ? 'Deactivate' : 'Activate'}
                                </button>
                                <button
                                    type="button"
                                    className="chip chip-tool"
                                    disabled={busy || isSelf}
                                    title={isSelf ? 'You cannot delete your own account.' : undefined}
                                    onClick={remove}
                                >
                                    Delete
                                </button>
                            </>
                        )}
                    </div>
                </td>
            </tr>
            {editOpen && (
                <tr className="admin-edit-row">
                    <td colSpan={6}>
                        <EditUserForm
                            user={user}
                            isSelf={isSelf}
                            isSuperAdmin={isSuperAdmin}
                            busy={busy}
                            onSubmitPatch={patch}
                            onNotice={onNotice}
                            onClose={() => setEditOpen(false)}
                        />
                    </td>
                </tr>
            )}
        </>
    );
}

function EditUserForm({ user, isSelf, isSuperAdmin, busy, onSubmitPatch, onNotice, onClose }) {
    const [displayName, setDisplayName] = useState(user.display_name || '');
    const [role, setRole] = useState(user.role);
    const [active, setActive] = useState(user.active ? 'active' : 'inactive');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');

    // The endpoint only accepts operator/admin/viewer, and nobody may demote
    // themselves or a super_admin out of the role that guards this page.
    const roleLocked = isSuperAdmin || isSelf;
    const activeLocked = isSuperAdmin || isSelf;

    async function onSubmit(e) {
        e.preventDefault();
        const body = {};
        const changes = [];

        const dn = displayName.trim();
        if (!dn) {
            onNotice({ kind: 'error', text: 'Display name cannot be empty.' });
            return;
        }
        if (dn !== (user.display_name || '')) {
            body.display_name = dn;
            changes.push('display name');
        }
        if (!roleLocked && role !== user.role) {
            body.role = role;
            changes.push('role');
        }
        if (!activeLocked && (active === 'active') !== !!user.active) {
            body.active = active === 'active';
            changes.push('status');
        }
        if (password || confirm) {
            if (password.length < 8) {
                onNotice({ kind: 'error', text: 'Password must be at least 8 characters.' });
                return;
            }
            if (password !== confirm) {
                onNotice({ kind: 'error', text: 'Passwords do not match.' });
                return;
            }
            body.password = password;
            changes.push('password');
        }
        if (!changes.length) {
            onNotice({ kind: 'error', text: 'Nothing to save — no fields were changed.' });
            return;
        }

        const ok = await onSubmitPatch(body, `Updated ${user.username} (${changes.join(', ')}).`);
        if (ok) {
            setPassword('');
            setConfirm('');
            onClose();
        }
    }

    return (
        <form className="admin-edit-form" onSubmit={onSubmit}>
            <p className="eyebrow-lite admin-edit-title">Edit {user.username}</p>
            <div className="admin-edit-grid">
                <label>
                    Display name
                    <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
                </label>
                <label>
                    Role
                    <select value={role} disabled={roleLocked} onChange={(e) => setRole(e.target.value)}>
                        {roleLocked && <option value={user.role}>{user.role}</option>}
                        {!roleLocked &&
                            ROLES.map((r) => (
                                <option key={r} value={r}>
                                    {r}
                                </option>
                            ))}
                    </select>
                </label>
                <label>
                    Status
                    <select value={active} disabled={activeLocked} onChange={(e) => setActive(e.target.value)}>
                        <option value="active">active</option>
                        <option value="inactive">inactive</option>
                    </select>
                </label>
                <label>
                    New password (min 8)
                    <input
                        type="password"
                        value={password}
                        autoComplete="new-password"
                        placeholder="leave blank to keep"
                        onChange={(e) => setPassword(e.target.value)}
                    />
                </label>
                <label>
                    Confirm new password
                    <input
                        type="password"
                        value={confirm}
                        autoComplete="new-password"
                        placeholder="leave blank to keep"
                        onChange={(e) => setConfirm(e.target.value)}
                    />
                </label>
            </div>
            {roleLocked && (
                <p className="admin-edit-hint">
                    {isSuperAdmin
                        ? 'Role and status are fixed for a super_admin account; display name and password can still be changed.'
                        : 'You cannot change your own role or deactivate your own account.'}
                </p>
            )}
            <div className="admin-edit-actions">
                <button type="submit" className="btn-primary btn-sm" disabled={busy}>
                    {busy ? 'Saving…' : 'Save changes'}
                </button>
                <button type="button" className="chip chip-tool" disabled={busy} onClick={onClose}>
                    Cancel
                </button>
            </div>
        </form>
    );
}
