import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiFetch } from '../apiClient.js';

export function AdminOrgsPage() {
    const [orgs, setOrgs] = useState([]);
    const [users, setUsers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [err, setErr] = useState(null);
    const [createOpen, setCreateOpen] = useState(false);
    const [assignOpenFor, setAssignOpenFor] = useState(null);

    const reload = useCallback(async () => {
        setLoading(true);
        setErr(null);
        try {
            const [orgsR, usersR] = await Promise.all([
                apiFetch('/api/admin/orgs'),
                apiFetch('/api/admin/users')
            ]);
            const orgsJ = orgsR.ok ? await orgsR.json() : { orgs: [] };
            const usersJ = usersR.ok ? await usersR.json() : { users: [] };
            if (!orgsR.ok) throw new Error(orgsJ.error || `HTTP ${orgsR.status}`);
            setOrgs(orgsJ.orgs || []);
            setUsers(usersJ.users || []);
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
                    <h1 className="wordmark">Organizations</h1>
                    <p className="muted small">
                        Tenants for tile + admin scoping. Every user is assigned to one or more orgs;
                        the active org gates which runs they see in Letter Heads / Envelopes / Urine Containers.
                    </p>
                </div>
                <div className="admin-actions">
                    <Link to="/" className="chip chip-tool">
                        ← Back to dashboard
                    </Link>
                    <Link to="/admin/users" className="chip chip-tool">
                        Users
                    </Link>
                    <button type="button" className="btn-primary" onClick={() => setCreateOpen((v) => !v)}>
                        {createOpen ? 'Cancel' : 'New org'}
                    </button>
                </div>
            </header>

            {createOpen && (
                <CreateOrgForm
                    onCreated={() => {
                        setCreateOpen(false);
                        reload();
                    }}
                />
            )}

            {err && <div className="results-error nexus-card">{err}</div>}

            {loading ? (
                <p className="muted">Loading…</p>
            ) : (
                <table className="packages admin-orgs-table">
                    <thead>
                        <tr>
                            <th>Name</th>
                            <th>Slug</th>
                            <th>Members</th>
                            <th>Active</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orgs.map((o) => (
                            <OrgRow
                                key={o.id}
                                org={o}
                                users={users}
                                assignOpen={assignOpenFor === o.id}
                                onToggleAssign={() => setAssignOpenFor((v) => (v === o.id ? null : o.id))}
                                onChanged={reload}
                            />
                        ))}
                        {!orgs.length && (
                            <tr>
                                <td colSpan={5} className="muted">
                                    No organizations yet.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            )}
        </main>
    );
}

function CreateOrgForm({ onCreated }) {
    const [slug, setSlug] = useState('');
    const [name, setName] = useState('');
    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState(null);

    async function onSubmit(e) {
        e.preventDefault();
        setBusy(true);
        setErr(null);
        try {
            const r = await apiFetch('/api/admin/orgs', {
                method: 'POST',
                body: JSON.stringify({ slug: slug.trim().toLowerCase(), name: name.trim() })
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
            <h2 className="card-title-demoted">Create organization</h2>
            <div className="grid2 sidebar-grid">
                <label>
                    Slug{' '}
                    <input
                        value={slug}
                        onChange={(e) => setSlug(e.target.value)}
                        pattern="^[a-z0-9][a-z0-9-]*$"
                        placeholder="acme-labs"
                        required
                    />
                </label>
                <label>
                    Display name{' '}
                    <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Labs" required />
                </label>
            </div>
            {err && <p className="login-err">{err}</p>}
            <div className="form-actions">
                <button type="submit" className="btn-primary" disabled={busy}>
                    {busy ? 'Creating…' : 'Create org'}
                </button>
            </div>
        </form>
    );
}

function OrgRow({ org, users, assignOpen, onToggleAssign, onChanged }) {
    const [busy, setBusy] = useState(false);
    const isDefault = org.id === 'org-default';

    async function patch(body) {
        setBusy(true);
        try {
            const r = await apiFetch(`/api/admin/orgs/${org.id}`, {
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
        if (!window.confirm(`Delete org "${org.name}"? Members must already be reassigned.`)) return;
        setBusy(true);
        try {
            const r = await apiFetch(`/api/admin/orgs/${org.id}`, { method: 'DELETE' });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            onChanged();
        } catch (e) {
            window.alert(String(e.message || e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <>
            <tr>
                <td className="label">{org.name}</td>
                <td className="muted small">{org.slug}</td>
                <td>{org.member_count}</td>
                <td>{org.active ? '✓' : '—'}</td>
                <td className="admin-row-actions">
                    <button type="button" className="chip chip-tool" disabled={busy} onClick={onToggleAssign}>
                        {assignOpen ? 'Hide members' : 'Manage members'}
                    </button>
                    {!isDefault && (
                        <>
                            <button
                                type="button"
                                className="chip chip-tool"
                                disabled={busy}
                                onClick={() => patch({ active: !org.active })}
                            >
                                {org.active ? 'Deactivate' : 'Activate'}
                            </button>
                            <button type="button" className="chip chip-tool" disabled={busy} onClick={remove}>
                                Delete
                            </button>
                        </>
                    )}
                </td>
            </tr>
            {assignOpen && (
                <tr>
                    <td colSpan={5} className="audit-detail-cell">
                        <OrgMembersPanel orgId={org.id} users={users} onChanged={onChanged} />
                    </td>
                </tr>
            )}
        </>
    );
}

function OrgMembersPanel({ orgId, users, onChanged }) {
    const [members, setMembers] = useState([]);
    const [loading, setLoading] = useState(true);
    const [pickedUserId, setPickedUserId] = useState('');
    const [pickedRole, setPickedRole] = useState('member');

    const reload = useCallback(async () => {
        setLoading(true);
        try {
            // Per-org membership uses the per-user endpoint inverted: fetch all
            // users and pull each one's assignments. Cheap for a handful of orgs;
            // a dedicated /api/admin/orgs/:id/members can land later if we grow.
            const results = await Promise.all(
                users.map(async (u) => {
                    const r = await apiFetch(`/api/admin/users/${u.id}/orgs`);
                    const j = r.ok ? await r.json() : { assignments: [] };
                    const a = (j.assignments || []).find((x) => x.org_id === orgId);
                    return a ? { user: u, assignment: a } : null;
                })
            );
            setMembers(results.filter(Boolean));
        } finally {
            setLoading(false);
        }
    }, [orgId, users]);

    useEffect(() => {
        reload();
    }, [reload]);

    const unassignedUsers = users.filter((u) => !members.find((m) => m.user.id === u.id));

    async function assign() {
        if (!pickedUserId) return;
        const r = await apiFetch(`/api/admin/users/${pickedUserId}/orgs`, {
            method: 'POST',
            body: JSON.stringify({ org_id: orgId, role: pickedRole })
        });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            window.alert(j.error || `HTTP ${r.status}`);
            return;
        }
        setPickedUserId('');
        setPickedRole('member');
        await reload();
        onChanged();
    }

    async function unassign(userId) {
        if (!window.confirm('Remove this user from the org?')) return;
        const r = await apiFetch(`/api/admin/users/${userId}/orgs/${orgId}`, { method: 'DELETE' });
        if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            window.alert(j.error || `HTTP ${r.status}`);
            return;
        }
        await reload();
        onChanged();
    }

    return (
        <div className="org-members-panel">
            <p className="eyebrow-lite">Members</p>
            {loading ? (
                <p className="muted small">Loading…</p>
            ) : members.length ? (
                <ul className="org-members-list">
                    {members.map(({ user, assignment }) => (
                        <li key={user.id}>
                            <span>{user.display_name || user.username}</span>
                            <span className="muted small">{assignment.membership_role}</span>
                            <button
                                type="button"
                                className="chip chip-tool"
                                onClick={() => unassign(user.id)}
                            >
                                Remove
                            </button>
                        </li>
                    ))}
                </ul>
            ) : (
                <p className="muted small">No members yet.</p>
            )}

            {unassignedUsers.length > 0 && (
                <div className="org-members-add">
                    <label>
                        <span className="muted small">Add user</span>
                        <select value={pickedUserId} onChange={(e) => setPickedUserId(e.target.value)}>
                            <option value="">— pick a user —</option>
                            {unassignedUsers.map((u) => (
                                <option key={u.id} value={u.id}>
                                    {u.display_name || u.username}
                                </option>
                            ))}
                        </select>
                    </label>
                    <label>
                        <span className="muted small">Role</span>
                        <select value={pickedRole} onChange={(e) => setPickedRole(e.target.value)}>
                            <option value="member">member</option>
                            <option value="org_admin">org_admin</option>
                        </select>
                    </label>
                    <button type="button" className="btn-primary" disabled={!pickedUserId} onClick={assign}>
                        Assign
                    </button>
                </div>
            )}
        </div>
    );
}
