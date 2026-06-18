import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';

const AVATAR_COLORS = ['#6366f1','#ec4899','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];

export default function Team() {
  const { api, user, updateUser } = useAuth();
  const [users, setUsers] = useState([]);
  const [showNewUser, setShowNewUser] = useState(false);
  const [editingUser, setEditingUser] = useState(null);
  const [userForm, setUserForm] = useState({ name: '', email: '', password: '', role: 'editor' });
  const [editForm, setEditForm] = useState({ name: '', email: '', role: 'editor', avatar_color: '#6366f1', password: '', current_password: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api('/api/users').then(setUsers).catch(console.error); }, []);

  const initials = (name) => name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();

  const createUser = async () => {
    if (!userForm.name || !userForm.email || !userForm.password) return;
    setLoading(true); setError('');
    try {
      await api('/api/auth/register', { method: 'POST', body: userForm });
      const updated = await api('/api/users');
      setUsers(updated);
      setShowNewUser(false);
      setUserForm({ name: '', email: '', password: '', role: 'editor' });
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const openEdit = (u) => {
    setEditingUser(u);
    setEditForm({ name: u.name, email: u.email, role: u.role, avatar_color: u.avatar_color, password: '', current_password: '' });
    setError('');
  };

  const saveUser = async () => {
    if (!editForm.name || !editForm.email) { setError('Nombre y email son obligatorios'); return; }
    const isSelf = editingUser.id === user.id;
    if (editForm.password && isSelf && !editForm.current_password) {
      setError('Ingresá tu contraseña actual para cambiarla');
      return;
    }
    setLoading(true); setError('');
    try {
      const body = { name: editForm.name, email: editForm.email, role: editForm.role, avatar_color: editForm.avatar_color };
      if (editForm.password) {
        body.password = editForm.password;
        if (isSelf) body.current_password = editForm.current_password;
      }
      const updated = await api(`/api/users/${editingUser.id}`, { method: 'PATCH', body });
      setUsers(prev => prev.map(u => u.id === editingUser.id ? updated : u));
      if (isSelf) updateUser({ name: updated.name, email: updated.email, role: updated.role, avatar_color: updated.avatar_color });
      setEditingUser(null);
    } catch (e) { setError(e.message); }
    finally { setLoading(false); }
  };

  const deleteUser = async (id) => {
    if (!confirm('¿Eliminar este usuario? Se borrarán todos sus datos.')) return;
    try {
      await api(`/api/users/${id}`, { method: 'DELETE' });
      setUsers(prev => prev.filter(u => u.id !== id));
    } catch (e) { alert('Error: ' + e.message); }
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24 }}>
        <div>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', marginBottom: 4 }}>Equipo</h1>
          <p style={{ color: 'var(--text2)', fontSize: 14 }}>{users.length} miembro{users.length !== 1 ? 's' : ''} en total</p>
        </div>
        {user?.role === 'admin' && (
          <button className="btn btn-primary" onClick={() => { setShowNewUser(true); setError(''); }}>＋ Agregar editor</button>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
        {users.map(u => (
          <div key={u.id} className="card" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div className="avatar avatar-lg" style={{ background: u.avatar_color, cursor: user?.role === 'admin' ? 'pointer' : 'default' }}
              onClick={() => user?.role === 'admin' && openEdit(u)}
              title={user?.role === 'admin' ? 'Editar usuario' : undefined}>
              {initials(u.name)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>{u.name}</div>
              {u.email && <div style={{ color: 'var(--text2)', fontSize: 12, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.email}</div>}
              {u.role && <span className={`badge ${u.role === 'admin' ? 'badge-in_progress' : 'badge-todo'}`} style={{ marginTop: 6 }}>{u.role}</span>}
            </div>
            {user?.role === 'admin' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => openEdit(u)} title="Editar">✏️</button>
                {u.id !== user.id && (
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => deleteUser(u.id)} style={{ color: 'var(--red)' }} title="Eliminar">🗑</button>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modal: Crear usuario */}
      {showNewUser && (
        <div className="modal-overlay" onClick={() => setShowNewUser(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Agregar integrante</h2>
            <div className="form-group"><label>Nombre completo</label>
              <input className="input" value={userForm.name} onChange={e => setUserForm(p => ({ ...p, name: e.target.value }))} placeholder="Juan García" autoFocus />
            </div>
            <div className="form-group"><label>Email</label>
              <input className="input" type="email" value={userForm.email} onChange={e => setUserForm(p => ({ ...p, email: e.target.value }))} placeholder="juan@email.com" />
            </div>
            <div className="form-group"><label>Contraseña inicial</label>
              <input className="input" type="password" value={userForm.password} onChange={e => setUserForm(p => ({ ...p, password: e.target.value }))} placeholder="••••••••" />
            </div>
            <div className="form-group"><label>Rol</label>
              <select className="input" value={userForm.role} onChange={e => setUserForm(p => ({ ...p, role: e.target.value }))}>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12, background: 'rgba(240,92,92,0.08)', padding: '8px 12px', borderRadius: 8 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowNewUser(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={createUser} disabled={loading || !userForm.name || !userForm.email || !userForm.password}>
                {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Crear usuario'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Editar usuario */}
      {editingUser && (
        <div className="modal-overlay" onClick={() => setEditingUser(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Editar integrante</h2>

            {/* Color avatar */}
            <div className="form-group">
              <label>Color de avatar</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 4 }}>
                {AVATAR_COLORS.map(c => (
                  <div key={c} onClick={() => setEditForm(p => ({ ...p, avatar_color: c }))}
                    style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                      border: editForm.avatar_color === c ? '3px solid var(--text)' : '3px solid transparent',
                      transition: 'border 0.15s', display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 10, fontWeight: 700, color: '#fff' }}>
                    {editForm.avatar_color === c ? '✓' : ''}
                  </div>
                ))}
              </div>
              {/* Preview */}
              <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 10 }}>
                <div className="avatar avatar-lg" style={{ background: editForm.avatar_color }}>{initials(editForm.name || editingUser.name)}</div>
                <span style={{ fontSize: 13, color: 'var(--text2)' }}>Vista previa</span>
              </div>
            </div>

            <div className="form-group"><label>Nombre completo</label>
              <input className="input" value={editForm.name} onChange={e => setEditForm(p => ({ ...p, name: e.target.value }))} autoFocus />
            </div>
            <div className="form-group"><label>Email</label>
              <input className="input" type="email" value={editForm.email} onChange={e => setEditForm(p => ({ ...p, email: e.target.value }))} />
            </div>
            <div className="form-group"><label>Rol</label>
              <select className="input" value={editForm.role} onChange={e => setEditForm(p => ({ ...p, role: e.target.value }))}>
                <option value="editor">Editor</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div className="form-group">
              <label>Nueva contraseña <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(dejar vacío para no cambiar)</span></label>
              <input className="input" type="password" value={editForm.password} onChange={e => setEditForm(p => ({ ...p, password: e.target.value }))} placeholder="••••••••" />
            </div>
            {editingUser.id === user.id && editForm.password && (
              <div className="form-group">
                <label>Contraseña actual <span style={{ color: 'var(--text3)', fontWeight: 400 }}>(para confirmar el cambio)</span></label>
                <input className="input" type="password" value={editForm.current_password} onChange={e => setEditForm(p => ({ ...p, current_password: e.target.value }))} placeholder="••••••••" />
              </div>
            )}
            {error && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12, background: 'rgba(240,92,92,0.08)', padding: '8px 12px', borderRadius: 8 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setEditingUser(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveUser} disabled={loading}>
                {loading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Guardar cambios'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
