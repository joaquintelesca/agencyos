import { useState, useEffect } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { initials } from '../utils/format';

const COLORS = ['#6366f1','#10b981','#f59e0b','#ec4899','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];

export default function Layout() {
  const { user, logout, api, socket } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const [clients, setClients] = useState([]);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewClient, setShowNewClient] = useState(false);
  const [clientForm, setClientForm] = useState({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
  const [step, setStep] = useState(1);
  const [projectForm, setProjectForm] = useState({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '' });
  const [paymentForm, setPaymentForm] = useState({ payment_editor_id: '', payment_type: 'fixed', payment_amount: '', payment_rate: '', payment_hours: '', client_amount: '', client_rate: '' });
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  const [chatUnread, setChatUnread] = useState({});
  const [editingClient, setEditingClient] = useState(null);
  const [editClientForm, setEditClientForm] = useState({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
  const [editingProject, setEditingProject] = useState(null);
  const [editProjectForm, setEditProjectForm] = useState({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '', payment_editor_id: '', payment_type: 'fixed', payment_amount: '', client_amount: '', payment_hours: '' });
  const [storageWarning, setStorageWarning] = useState(null); // { gb, bytes } | null
  const [sidebarError, setSidebarError] = useState('');
  const [sidebarRetryCount, setSidebarRetryCount] = useState(0);
  const [expandedClients, setExpandedClients] = useState([]); // string[] de client IDs
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ current_password: '', password: '', confirm: '' });
  const [passwordError, setPasswordError] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  useEffect(() => {
    if (!user) return; // wait for auth
    setSidebarError('');
    // Proyectos y clientes son lo que arma el sidebar entero — si fallan, antes el usuario
    // se quedaba con un sidebar vacío sin saber si es que no tiene nada o si hubo un error real.
    api('/api/projects').then(setProjects).catch(e => { console.error(e); setSidebarError('No se pudieron cargar los proyectos.'); });
    if (user?.role === 'admin') {
      api('/api/users').then(setUsers).catch(console.error);
      api('/api/storage').then(s => { if (s.warning) setStorageWarning(s); }).catch(console.error);
    }
    api('/api/clients').then(setClients).catch(e => { console.error(e); setSidebarError(prev => prev || 'No se pudieron cargar los clientes.'); });
    api('/api/notifications').then(n => setUnreadNotifs(n.filter(x => !x.read).length)).catch(console.error);
    api('/api/chat/unread').then(setChatUnread).catch(console.error);
  }, [user?.id, sidebarRetryCount]);

  useEffect(() => {
    if (!socket) return;
    const onNotif = () => { setUnreadNotifs(prev => prev + 1); api('/api/projects').then(setProjects).catch(console.error); };
    const onRead = () => { api('/api/chat/unread').then(setChatUnread).catch(console.error); };
    const onStorageWarn = (s) => setStorageWarning(s);
    const onChatMessage = () => { api('/api/chat/unread').then(setChatUnread).catch(console.error); };
    // Antes el sidebar solo se refrescaba vía notification:new (que no llega a todos los admins,
    // solo al editor asignado) — otro admin no veía un proyecto/cliente nuevo hasta recargar la
    // página a mano. Ahora se actualiza el estado local directo con estos eventos.
    const onProjectCreated = (p) => setProjects(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
    const onProjectUpdated = (p) => setProjects(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? p : x) : [p, ...prev]);
    const onProjectDeleted = ({ id }) => setProjects(prev => prev.filter(p => p.id !== id));
    const onClientCreated = (c) => setClients(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c].sort((a, b) => a.name.localeCompare(b.name)));
    const onClientUpdated = (c) => setClients(prev => prev.map(x => x.id === c.id ? c : x));
    const onClientDeleted = ({ id }) => setClients(prev => prev.filter(c => c.id !== id));
    socket.on('notification:new', onNotif);
    socket.on('chat:read', onRead);
    socket.on('chat:message', onChatMessage);
    socket.on('storage:warning', onStorageWarn);
    socket.on('project:created', onProjectCreated);
    socket.on('project:updated', onProjectUpdated);
    socket.on('project:deleted', onProjectDeleted);
    socket.on('client:created', onClientCreated);
    socket.on('client:updated', onClientUpdated);
    socket.on('client:deleted', onClientDeleted);
    return () => {
      socket.off('notification:new', onNotif); socket.off('chat:read', onRead); socket.off('chat:message', onChatMessage); socket.off('storage:warning', onStorageWarn);
      socket.off('project:created', onProjectCreated); socket.off('project:updated', onProjectUpdated); socket.off('project:deleted', onProjectDeleted);
      socket.off('client:created', onClientCreated); socket.off('client:updated', onClientUpdated); socket.off('client:deleted', onClientDeleted);
    };
  }, [socket]);

  const openNewProject = () => { setStep(1); setProjectForm({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '' }); setPaymentForm({ payment_editor_id: '', payment_type: 'fixed', payment_amount: '', payment_rate: '', payment_hours: '' }); setShowNewProject(true); };

  const createClient = async () => {
    if (!clientForm.name.trim()) return;
    try {
      await api('/api/clients', { method: 'POST', body: clientForm });
      const updated = await api('/api/clients');
      setClients(updated);
      setShowNewClient(false);
      setClientForm({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
    } catch (e) {
      console.error('Error creando cliente:', e);
      alert('Error: ' + e.message);
    }
  };

  const saveProject = async () => {
    if (!editProjectForm.name.trim()) return;
    try {
      const updated = await api(`/api/projects/${editingProject.id}`, { method: 'PUT', body: { ...editingProject, ...editProjectForm } });
      setProjects(prev => prev.map(p => p.id === editingProject.id ? { ...p, ...updated } : p));
      setEditingProject(null);
    } catch (e) { console.error(e); alert('Error: ' + e.message); }
  };

  const saveClient = async () => {
    if (!editClientForm.name.trim()) return;
    try {
      await api(`/api/clients/${editingClient.id}`, { method: 'PATCH', body: editClientForm });
      const updated = await api('/api/clients');
      setClients(updated);
      setEditingClient(null);
    } catch (e) { console.error(e); alert('Error: ' + e.message); }
  };

  const openChangePassword = () => {
    setPasswordForm({ current_password: '', password: '', confirm: '' });
    setPasswordError('');
    setShowChangePassword(true);
  };

  const changePassword = async () => {
    setPasswordError('');
    if (!passwordForm.current_password || !passwordForm.password || !passwordForm.confirm) {
      setPasswordError('Completá todos los campos');
      return;
    }
    if (passwordForm.password.length < 6) {
      setPasswordError('La nueva contraseña debe tener al menos 6 caracteres');
      return;
    }
    if (passwordForm.password !== passwordForm.confirm) {
      setPasswordError('Las contraseñas no coinciden');
      return;
    }
    setPasswordLoading(true);
    try {
      await api(`/api/users/${user.id}`, {
        method: 'PATCH',
        body: { current_password: passwordForm.current_password, password: passwordForm.password }
      });
      setShowChangePassword(false);
    } catch (e) {
      setPasswordError(e.message);
    } finally {
      setPasswordLoading(false);
    }
  };

  const deleteProject = async (id) => {
    if (!confirm('¿Eliminar este proyecto? Se borrarán todas sus tareas, videos y mensajes.')) return;
    try {
      await api(`/api/projects/${id}`, { method: 'DELETE' });
      setProjects(prev => prev.filter(p => p.id !== id));
      if (location.pathname === `/project/${id}`) navigate('/');
    } catch (e) { console.error(e); alert('Error al eliminar el proyecto: ' + e.message); }
  };

  const openEditProject = (p) => {
    setEditingProject(p);
    setEditProjectForm({ name: p.name, description: p.description || '', color: p.color, client_id: p.client_id || '', deadline: p.deadline || '', payment_editor_id: p.payment_editor_id || '', payment_type: p.payment_type || 'fixed', payment_amount: p.payment_amount || '', client_amount: p.client_amount || '', payment_hours: p.payment_hours || '' });
  };

  const deleteClient = async (c) => {
    if (!confirm(`¿Eliminar cliente "${c.name}"?`)) return;
    try {
      await api(`/api/clients/${c.id}`, { method: 'DELETE' });
      setClients(prev => prev.filter(x => x.id !== c.id));
    } catch (e) { console.error(e); alert('Error al eliminar el cliente: ' + e.message); }
  };

  const goToStep2 = () => { if (!projectForm.name.trim()) return; setStep(2); };

  const createProject = async () => {
    const body = { ...projectForm };
    if (user?.role === 'admin' && paymentForm.payment_editor_id) {
      body.payment_editor_id = paymentForm.payment_editor_id;
      body.payment_type = paymentForm.payment_type;
      body.payment_amount = paymentForm.payment_type === 'fixed' ? paymentForm.payment_amount : paymentForm.payment_rate;
      body.payment_hours = paymentForm.payment_hours || 0;
      body.client_amount = paymentForm.payment_type === 'fixed' ? paymentForm.client_amount : paymentForm.client_rate;
    }
    const p = await api('/api/projects', { method: 'POST', body });
    setProjects(prev => [p, ...prev]);
    setShowNewProject(false);
    navigate(`/project/${p.id}`);
  };

  const isActive = (path) => location.pathname === path;
  const isProjectActive = (id) => location.pathname === `/project/${id}`;

  const estimatedTotal = () => {
    if (paymentForm.payment_type === 'hourly') {
      const rate = parseFloat(paymentForm.payment_rate) || 0;
      const hours = parseFloat(paymentForm.payment_hours) || 0;
      return rate * hours;
    }
    return parseFloat(paymentForm.payment_amount) || 0;
  };

  const estimatedClientTotal = () => {
    if (paymentForm.payment_type === 'hourly') {
      const rate = parseFloat(paymentForm.client_rate) || 0;
      const hours = parseFloat(paymentForm.payment_hours) || 0;
      return rate * hours;
    }
    return parseFloat(paymentForm.client_amount) || 0;
  };

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Sidebar */}
      <aside style={{ width: 220, background: 'var(--bg2)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, background: 'var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>🎬</div>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, letterSpacing: '-0.02em' }}>AgencyOS</span>
        </div>

        <div style={{ padding: '12px 8px 6px' }}>
          <SideLabel>General</SideLabel>
          <NavItem to="/" label="Dashboard" icon="🏠" active={isActive('/')} />
          <NavItem to="/chat" label="Chat" icon="💬" active={isActive('/chat')} badge={Object.values(chatUnread).reduce((a, b) => a + b, 0)} />
          <NavItem to="/team" label="Equipo" icon="👥" active={isActive('/team')} />
          <NavItem to="/notifications" label="Notificaciones" icon="🔔" active={isActive('/notifications')} badge={unreadNotifs} badgeRed />
          {user?.role === 'admin' && (
            <NavItem to="/payments" label="Pagos" icon="💰" active={isActive('/payments')} admin />
          )}
        </div>

        <div style={{ padding: '8px 8px 6px', flex: 1, overflowY: 'auto' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px', marginBottom: 4 }}>
            <SideLabel>Clientes</SideLabel>
            {user?.role === 'admin' && (
              <button onClick={() => setShowNewClient(true)} style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16, lineHeight: 1, padding: '0 4px' }} title="Nuevo cliente">＋</button>
            )}
          </div>

          {sidebarError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 7, padding: '6px 8px', marginBottom: 6, fontSize: 11, color: 'var(--red)' }}>
              <span style={{ flex: 1 }}>⚠️ {sidebarError}</span>
              <button onClick={() => setSidebarRetryCount(c => c + 1)} style={{ background: 'transparent', border: '1px solid var(--red)', borderRadius: 5, padding: '2px 6px', color: 'var(--red)', fontSize: 10, cursor: 'pointer', flexShrink: 0 }}>Reintentar</button>
            </div>
          )}

          {/* Projects grouped by client — click to expand */}
          {clients.map(c => {
            const clientProjects = projects.filter(p => p.client_id === c.id);
            const isExpanded = expandedClients.includes(c.id);
            return (
              <div key={c.id} style={{ marginBottom: 2 }}>
                <div className="sidebar-row" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 7, cursor: 'pointer', transition: 'background 0.1s' }}
                  onClick={() => setExpandedClients(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                  onDoubleClick={e => { e.stopPropagation(); navigate(`/client/${c.id}`); }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ fontSize: 10, color: 'var(--text3)', transition: 'transform 0.15s', display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>▶</span>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  {user?.role === 'admin' && clientProjects.some(p => p.review_count > 0) && (
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                  )}
                  {clientProjects.length > 0 && <span style={{ fontSize: 10, color: 'var(--text3)' }}>{clientProjects.length}</span>}
                  {user?.role === 'admin' && (
                    <ProjectRowActions fontSize={12} padding="1px 4px"
                      onEdit={e => { e.stopPropagation(); setEditingClient(c); setEditClientForm({ name: c.name, color: c.color, email: c.email || '', phone: c.phone || '', notes: c.notes || '' }); }}
                      onDelete={e => { e.stopPropagation(); deleteClient(c); }} />
                  )}
                </div>
                {isExpanded && clientProjects.map(p => (
                  <div key={p.id} className="sidebar-row" style={{ display: 'flex', alignItems: 'center', borderRadius: 7, marginBottom: 1, background: isProjectActive(p.id) ? 'var(--bg3)' : 'transparent', transition: 'all 0.1s' }}>
                    <Link to={`/project/${p.id}`} style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px 5px 26px', cursor: 'pointer', color: isProjectActive(p.id) ? 'var(--text)' : 'var(--text2)', fontSize: 12 }}>
                        <div style={{ width: 6, height: 6, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        {user?.role === 'admin' && p.review_count > 0 && (
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                        )}
                      </div>
                    </Link>
                    {user?.role === 'admin' && (
                      <ProjectRowActions fontSize={12} padding="5px 4px"
                        onEdit={e => { e.preventDefault(); openEditProject(p); }}
                        onDelete={e => { e.preventDefault(); deleteProject(p.id); }} />
                    )}
                  </div>
                ))}
                {isExpanded && clientProjects.length === 0 && (
                  <div style={{ padding: '4px 10px 4px 26px', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin proyectos aún</div>
                )}
              </div>
            );
          })}

          {/* Projects without client */}
          {projects.filter(p => !p.client_id).map(p => (
            <div key={p.id} className="sidebar-row" style={{ display: 'flex', alignItems: 'center', borderRadius: 7, marginBottom: 1, background: isProjectActive(p.id) ? 'var(--bg3)' : 'transparent', transition: 'all 0.1s' }}>
              <Link to={`/project/${p.id}`} style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', color: isProjectActive(p.id) ? 'var(--text)' : 'var(--text2)', fontSize: 13 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {user?.role === 'admin' && p.review_count > 0 && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                  )}
                </div>
              </Link>
              {user?.role === 'admin' && (
                <ProjectRowActions fontSize={13} padding="6px 4px"
                  onEdit={e => { e.preventDefault(); openEditProject(p); }}
                  onDelete={e => { e.preventDefault(); deleteProject(p.id); }} />
              )}
            </div>
          ))}

          <button onClick={openNewProject} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer', width: '100%', marginTop: 4, borderRadius: 7 }}>
            <span>＋</span> Nuevo proyecto
          </button>
        </div>

        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="avatar" style={{ background: user?.avatar_color || 'var(--accent)' }}>{initials(user?.name)}</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user?.name}</div>
            <div style={{ fontSize: 10, color: 'var(--text3)' }}>{user?.role}</div>
          </div>
          <button onClick={openChangePassword} title="Cambiar contraseña" style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16 }}>🔑</button>
          <button onClick={logout} title="Cerrar sesión" style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16 }}>⏻</button>
        </div>
      </aside>

      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {storageWarning && user?.role === 'admin' && (
          <div style={{ background: '#f59e0b15', borderBottom: '1px solid #f59e0b50', padding: '8px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 13, color: '#f59e0b', fontWeight: 600 }}>Almacenamiento: {storageWarning.gb} GB usados</span>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>— Superaste los 20GB. Considerá borrar archivos viejos o migrar a la nube.</span>
            </div>
            <button onClick={() => setStorageWarning(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 16, padding: '0 4px' }}>✕</button>
          </div>
        )}
        <Outlet context={{ projects, setProjects, unreadNotifs, setUnreadNotifs }} />
      </main>

      {/* New Project Modal */}
      {showNewProject && (
        <div className="modal-overlay" onClick={() => setShowNewProject(false)}>
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>

            {/* Steps indicator — solo admin ve 2 pasos */}
            {user?.role === 'admin' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 20 }}>
                {[{ n: 1, label: 'Proyecto' }, { n: 2, label: 'Pago' }].map((s, i) => (
                  <div key={s.n} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {i > 0 && <div style={{ width: 24, height: 1, background: 'var(--border2)' }} />}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <div style={{ width: 24, height: 24, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: step > s.n ? 'var(--green)' : step === s.n ? 'var(--accent)' : 'var(--bg4)', color: step >= s.n ? '#fff' : 'var(--text3)' }}>
                        {step > s.n ? '✓' : s.n}
                      </div>
                      <span style={{ fontSize: 12, fontWeight: 500, color: step === s.n ? 'var(--text)' : 'var(--text3)' }}>{s.label}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Step 1 — datos del proyecto */}
            {step === 1 && (
              <>
                <h2>{user?.role === 'admin' ? 'Nuevo proyecto — Paso 1' : 'Nuevo proyecto'}</h2>
                <div className="form-group">
                  <label>Nombre</label>
                  <input className="input" value={projectForm.name} onChange={e => setProjectForm(p => ({ ...p, name: e.target.value }))} placeholder="Ej: Campaña Nike 2024" autoFocus />
                </div>
                <div className="form-group">
                  <label>Descripción (opcional)</label>
                  <textarea className="input" value={projectForm.description} onChange={e => setProjectForm(p => ({ ...p, description: e.target.value }))} placeholder="¿De qué se trata este proyecto?" />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div className="form-group">
                    <label>Cliente (opcional)</label>
                    <select className="input" value={projectForm.client_id} onChange={e => setProjectForm(p => ({ ...p, client_id: e.target.value }))}>
                      <option value="">Sin cliente</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Deadline (opcional)</label>
                    <input className="input" type="date" value={projectForm.deadline} onChange={e => setProjectForm(p => ({ ...p, deadline: e.target.value }))} />
                  </div>
                </div>
                <div className="form-group">
                  <label>Color</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {COLORS.map(c => (
                      <div key={c} onClick={() => setProjectForm(p => ({ ...p, color: c }))} style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: projectForm.color === c ? '2px solid white' : '2px solid transparent', boxShadow: projectForm.color === c ? '0 0 0 2px ' + c : 'none', transition: 'all 0.15s' }} />
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setShowNewProject(false)}>Cancelar</button>
                  {user?.role === 'admin'
                    ? <button className="btn btn-primary" onClick={goToStep2} disabled={!projectForm.name.trim()}>Siguiente →</button>
                    : <button className="btn btn-primary" onClick={createProject} disabled={!projectForm.name.trim()}>Crear proyecto</button>
                  }
                </div>
              </>
            )}

            {/* Step 2 — pago (solo admin) */}
            {step === 2 && user?.role === 'admin' && (
              <>
                <h2>Paso 2 — Configuración de pago</h2>
                <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--yellow)' }}>
                  🔒 Esta información es solo visible para vos
                </div>
                <div className="form-group">
                  <label>Editor responsable del pago</label>
                  <select className="input" value={paymentForm.payment_editor_id} onChange={e => setPaymentForm(p => ({ ...p, payment_editor_id: e.target.value }))}
                    style={!paymentForm.payment_editor_id ? { borderColor: 'var(--red)' } : {}}>
                    <option value="">Seleccioná un editor</option>
                    {users.filter(u => u.id !== user.id).map(u => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                  </select>
                </div>
                {paymentForm.payment_editor_id && (
                  <>
                    <div className="form-group">
                      <label>Tipo de pago</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                        {[['fixed', '💵', 'Precio fijo', 'Monto total del proyecto'], ['hourly', '⏱', 'Por horas', 'Precio × horas trabajadas']].map(([val, icon, label, sub]) => (
                          <div key={val} onClick={() => setPaymentForm(p => ({ ...p, payment_type: val }))} style={{ padding: 12, borderRadius: 8, border: `1px solid ${paymentForm.payment_type === val ? 'var(--accent)' : 'var(--border)'}`, background: paymentForm.payment_type === val ? 'var(--accent-glow)' : 'var(--bg3)', cursor: 'pointer', textAlign: 'center' }}>
                            <div style={{ fontSize: 20, marginBottom: 4 }}>{icon}</div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: paymentForm.payment_type === val ? 'var(--accent2)' : 'var(--text)' }}>{label}</div>
                            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{sub}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {paymentForm.payment_type === 'fixed' ? (
                      <div className="form-row">
                        <div className="form-group">
                          <label>Pago al editor ($) <span style={{ color: 'var(--red)' }}>*</span></label>
                          <input className="input" type="number" min="0" value={paymentForm.payment_amount} onChange={e => setPaymentForm(p => ({ ...p, payment_amount: e.target.value }))} placeholder="Ej: 500" style={!paymentForm.payment_amount ? { borderColor: 'var(--red)' } : {}} />
                        </div>
                        <div className="form-group">
                          <label>Cobro al cliente ($)</label>
                          <input className="input" type="number" min="0" value={paymentForm.client_amount} onChange={e => setPaymentForm(p => ({ ...p, client_amount: e.target.value }))} placeholder="Ej: 800" />
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="form-row">
                          <div className="form-group">
                            <label>Tarifa editor ($/h) <span style={{ color: 'var(--red)' }}>*</span></label>
                            <input className="input" type="number" min="0" value={paymentForm.payment_rate} onChange={e => setPaymentForm(p => ({ ...p, payment_rate: e.target.value }))} placeholder="Ej: 25" style={!paymentForm.payment_rate ? { borderColor: 'var(--red)' } : {}} />
                          </div>
                          <div className="form-group">
                            <label>Tarifa cliente ($/h)</label>
                            <input className="input" type="number" min="0" value={paymentForm.client_rate} onChange={e => setPaymentForm(p => ({ ...p, client_rate: e.target.value }))} placeholder="Ej: 40" />
                          </div>
                        </div>
                        <div className="form-group">
                          <label>Horas estimadas</label>
                          <input className="input" type="number" min="0" value={paymentForm.payment_hours} onChange={e => setPaymentForm(p => ({ ...p, payment_hours: e.target.value }))} placeholder="Ej: 20" />
                        </div>
                      </>
                    )}
                    {(estimatedTotal() > 0 || estimatedClientTotal() > 0) && (
                      <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: '#be185d' }}>Pago editor:</span>
                          <span style={{ fontSize: 16, fontWeight: 700, color: '#be185d' }}>${estimatedTotal().toFixed(0)}</span>
                        </div>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: '#4338ca' }}>Cobro cliente:</span>
                          <span style={{ fontSize: 16, fontWeight: 700, color: '#4338ca' }}>${estimatedClientTotal().toFixed(0)}</span>
                        </div>
                        {estimatedClientTotal() > estimatedTotal() && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                            <span style={{ fontSize: 12, color: 'var(--green)' }}>Ganancia:</span>
                            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>${(estimatedClientTotal() - estimatedTotal()).toFixed(0)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                )}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setStep(1)}>← Volver</button>
                  <button className="btn btn-primary" onClick={createProject} disabled={!paymentForm.payment_editor_id || (paymentForm.payment_type === 'fixed' ? !paymentForm.payment_amount : !paymentForm.payment_rate)}>Crear proyecto</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showNewClient && (
        <div className="modal-overlay" onClick={() => setShowNewClient(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Nuevo cliente</h2>
            <div className="form-group">
              <label>Nombre</label>
              <input className="input" value={clientForm.name} onChange={e => setClientForm(p => ({ ...p, name: e.target.value }))} placeholder="Ej: Nike, Adidas..." autoFocus />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label>Email (opcional)</label>
                <input className="input" type="email" value={clientForm.email} onChange={e => setClientForm(p => ({ ...p, email: e.target.value }))} placeholder="contacto@cliente.com" />
              </div>
              <div className="form-group">
                <label>Teléfono (opcional)</label>
                <input className="input" value={clientForm.phone} onChange={e => setClientForm(p => ({ ...p, phone: e.target.value }))} placeholder="+1 555 0100" />
              </div>
            </div>
            <div className="form-group">
              <label>Notas internas (opcional)</label>
              <textarea className="input" value={clientForm.notes} onChange={e => setClientForm(p => ({ ...p, notes: e.target.value }))} placeholder="Preferencias, observaciones..." rows={3} />
            </div>
            <div className="form-group">
              <label>Color</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {COLORS.map(c => (
                  <div key={c} onClick={() => setClientForm(p => ({ ...p, color: c }))} style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: clientForm.color === c ? '2px solid white' : '2px solid transparent', boxShadow: clientForm.color === c ? '0 0 0 2px ' + c : 'none', transition: 'all 0.15s' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowNewClient(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={createClient} disabled={!clientForm.name.trim()}>Crear cliente</button>
            </div>
          </div>
        </div>
      )}
      {editingProject && (
        <div className="modal-overlay" onClick={() => setEditingProject(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Editar proyecto — {editingProject.name}</h2>
            <div className="form-group">
              <label>Nombre</label>
              <input className="input" value={editProjectForm.name} onChange={e => setEditProjectForm(p => ({ ...p, name: e.target.value }))} autoFocus />
            </div>
            <div className="form-group">
              <label>Descripción</label>
              <textarea className="input" value={editProjectForm.description} onChange={e => setEditProjectForm(p => ({ ...p, description: e.target.value }))} rows={2} />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label>Cliente</label>
                <select className="input" value={editProjectForm.client_id} onChange={e => setEditProjectForm(p => ({ ...p, client_id: e.target.value }))}>
                  <option value="">Sin cliente</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Deadline</label>
                <input className="input" type="date" value={editProjectForm.deadline} onChange={e => setEditProjectForm(p => ({ ...p, deadline: e.target.value }))} />
              </div>
            </div>
            {user?.role === 'admin' && (
              <div className="form-group">
                <label>Editor asignado</label>
                <select className="input" value={editProjectForm.payment_editor_id} onChange={e => setEditProjectForm(p => ({ ...p, payment_editor_id: e.target.value }))}
                  style={!editProjectForm.payment_editor_id ? { borderColor: 'var(--red)' } : {}}>
                  <option value="">Seleccioná un editor</option>
                  {users.filter(u => u.id !== user.id).map(u => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
            )}
            {user?.role === 'admin' && (
              <>
                <div className="form-group">
                  <label>Tipo de pago</label>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                    {[['fixed', '💵 Precio fijo'], ['hourly', '⏱ Por horas']].map(([val, label]) => (
                      <button key={val} type="button" onClick={() => setEditProjectForm(p => ({ ...p, payment_type: val }))}
                        style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${editProjectForm.payment_type === val ? 'var(--accent)' : 'var(--border)'}`, background: editProjectForm.payment_type === val ? 'var(--accent-glow)' : 'var(--bg3)', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: editProjectForm.payment_type === val ? 'var(--accent2)' : 'var(--text2)', fontFamily: 'var(--font)' }}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: editProjectForm.payment_type === 'hourly' ? '1fr 1fr 1fr' : '1fr 1fr', gap: 10 }}>
                  <div className="form-group">
                    <label>{editProjectForm.payment_type === 'hourly' ? 'Tarifa editor ($/h)' : 'Pago al editor ($)'} <span style={{ color: 'var(--red)' }}>*</span></label>
                    <input className="input" type="number" min="0" value={editProjectForm.payment_amount} onChange={e => setEditProjectForm(p => ({ ...p, payment_amount: e.target.value }))} placeholder="Ej: 500"
                      style={!editProjectForm.payment_amount ? { borderColor: 'var(--red)' } : {}} />
                  </div>
                  <div className="form-group">
                    <label>{editProjectForm.payment_type === 'hourly' ? 'Tarifa cliente ($/h)' : 'Cobro al cliente ($)'}</label>
                    <input className="input" type="number" min="0" value={editProjectForm.client_amount} onChange={e => setEditProjectForm(p => ({ ...p, client_amount: e.target.value }))} placeholder="Ej: 800" />
                  </div>
                  {editProjectForm.payment_type === 'hourly' && (
                    <div className="form-group">
                      <label>Horas estimadas</label>
                      <input className="input" type="number" min="0" value={editProjectForm.payment_hours} onChange={e => setEditProjectForm(p => ({ ...p, payment_hours: e.target.value }))} placeholder="Ej: 20" />
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="form-group">
              <label>Color</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {COLORS.map(c => (
                  <div key={c} onClick={() => setEditProjectForm(p => ({ ...p, color: c }))} style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: editProjectForm.color === c ? '2px solid white' : '2px solid transparent', boxShadow: editProjectForm.color === c ? '0 0 0 2px ' + c : 'none', transition: 'all 0.15s' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setEditingProject(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveProject} disabled={!editProjectForm.name.trim()}>Guardar cambios</button>
            </div>
          </div>
        </div>
      )}

      {editingClient && (
        <div className="modal-overlay" onClick={() => setEditingClient(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Editar cliente — {editingClient.name}</h2>
            <div className="form-group">
              <label>Nombre</label>
              <input className="input" value={editClientForm.name} onChange={e => setEditClientForm(p => ({ ...p, name: e.target.value }))} autoFocus />
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="form-group">
                <label>Email</label>
                <input className="input" type="email" value={editClientForm.email} onChange={e => setEditClientForm(p => ({ ...p, email: e.target.value }))} placeholder="contacto@cliente.com" />
              </div>
              <div className="form-group">
                <label>Teléfono</label>
                <input className="input" value={editClientForm.phone} onChange={e => setEditClientForm(p => ({ ...p, phone: e.target.value }))} placeholder="+1 555 0100" />
              </div>
            </div>
            <div className="form-group">
              <label>Notas internas</label>
              <textarea className="input" value={editClientForm.notes} onChange={e => setEditClientForm(p => ({ ...p, notes: e.target.value }))} rows={3} />
            </div>
            <div className="form-group">
              <label>Color</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {COLORS.map(c => (
                  <div key={c} onClick={() => setEditClientForm(p => ({ ...p, color: c }))} style={{ width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer', border: editClientForm.color === c ? '2px solid white' : '2px solid transparent', boxShadow: editClientForm.color === c ? '0 0 0 2px ' + c : 'none', transition: 'all 0.15s' }} />
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setEditingClient(null)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveClient} disabled={!editClientForm.name.trim()}>Guardar cambios</button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Cambiar contraseña */}
      {showChangePassword && (
        <div className="modal-overlay" onClick={() => setShowChangePassword(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Cambiar contraseña</h2>
            <div className="form-group">
              <label>Contraseña actual</label>
              <input className="input" type="password" value={passwordForm.current_password} onChange={e => setPasswordForm(p => ({ ...p, current_password: e.target.value }))} placeholder="••••••••" autoFocus />
            </div>
            <div className="form-group">
              <label>Nueva contraseña</label>
              <input className="input" type="password" value={passwordForm.password} onChange={e => setPasswordForm(p => ({ ...p, password: e.target.value }))} placeholder="Mínimo 6 caracteres" />
            </div>
            <div className="form-group">
              <label>Confirmar nueva contraseña</label>
              <input className="input" type="password" value={passwordForm.confirm} onChange={e => setPasswordForm(p => ({ ...p, confirm: e.target.value }))} placeholder="••••••••" />
            </div>
            {passwordError && <p style={{ color: 'var(--red)', fontSize: 13, marginBottom: 12, background: 'rgba(240,92,92,0.08)', padding: '8px 12px', borderRadius: 8 }}>{passwordError}</p>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowChangePassword(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={changePassword} disabled={passwordLoading}>
                {passwordLoading ? <span className="spinner" style={{ width: 16, height: 16 }} /> : 'Cambiar contraseña'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Botones editar/borrar de una fila de proyecto en el sidebar — solo visibles al pasar el mouse
// por la fila (clase .sidebar-row en el padre, ver index.css). Usado en las dos listas de
// proyectos (agrupados por cliente y sin cliente), antes duplicado en cada una.
function ProjectRowActions({ fontSize, padding, onEdit, onDelete }) {
  return (
    <div style={{ display: 'flex', gap: 0 }}>
      <button className="reveal-btn edit" onClick={onEdit} style={{ fontSize, padding }}>✏️</button>
      <button className="reveal-btn delete" onClick={onDelete} style={{ fontSize, padding }}>🗑</button>
    </div>
  );
}

function SideLabel({ children }) {
  return <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.08em', padding: '0 8px', marginBottom: 4 }}>{children}</div>;
}

function NavItem({ to, label, icon, active, admin, badge, badgeRed }) {
  return (
    <Link to={to} style={{ textDecoration: 'none' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', borderRadius: 7, marginBottom: 1, cursor: 'pointer', background: active ? 'var(--bg3)' : 'transparent', color: active ? 'var(--text)' : 'var(--text2)', fontSize: 13, transition: 'all 0.1s' }}>
        <span>{icon}</span>
        <span style={{ flex: 1 }}>{label}</span>
        {admin && <span style={{ fontSize: 9, background: 'rgba(245,158,11,0.15)', color: '#f59e0b', padding: '1px 5px', borderRadius: 4, fontWeight: 700 }}>ADMIN</span>}
        {badge > 0 && <span style={{ background: badgeRed ? 'var(--red)' : 'var(--accent)', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 10, minWidth: 18, textAlign: 'center' }}>{badge}</span>}
      </div>
    </Link>
  );
}
