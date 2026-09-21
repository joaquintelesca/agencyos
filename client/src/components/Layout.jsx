import { useState, useEffect, useRef } from 'react';
import { Outlet, useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUndo } from '../context/UndoContext';
import { useAlert } from '../context/AlertContext';
import { initials } from '../utils/format';
import { notificationLabel, notificationTarget } from '../utils/notifications';
import { renderMentions } from './MentionInput';
import ErrorBoundary from './ErrorBoundary';
import SearchPalette from './SearchPalette';

const TOAST_DURATION_MS = 6000;

const COLORS =['#6366f1','#10b981','#f59e0b','#ec4899','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];

// Mismo email que OWNER_EMAIL en server/index.js — el único cuyo auto-asignarse como editor no
// representa un pago real (decisión explícita del usuario, no "cualquier admin"). Acá hace falta
// mientras se está editando el formulario (antes de guardar), donde no hay ninguna fila de
// proyecto con editor_is_owner ya calculado por el servidor para lo que se está por elegir.
const OWNER_EMAIL = 'joaquintelesca@gmail.com';

export default function Layout() {
  const { user, logout, api, socket } = useAuth();
  const { scheduleDelete } = useUndo();
  const { alert, confirm } = useAlert();
  const navigate = useNavigate();
  const location = useLocation();
  const [projects, setProjects] = useState([]);
  const [users, setUsers] = useState([]);
  const ownerUserId = users.find(u => u.email === OWNER_EMAIL)?.id;
  const [clients, setClients] = useState([]);
  const [showNewProject, setShowNewProject] = useState(false);
  const [showNewClient, setShowNewClient] = useState(false);
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [isCreatingClient, setIsCreatingClient] = useState(false);
  const [clientForm, setClientForm] = useState({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
  const [step, setStep] = useState(1);
  const [projectForm, setProjectForm] = useState({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '', material_link: '' });
  const [paymentForm, setPaymentForm] = useState({ payment_editor_id: '', payment_type: 'fixed', payment_amount: '', payment_rate: '', payment_hours: '', client_amount: '', client_rate: '', upwork_status: 'No', upwork_fee_pct: '', client_paid: 'unpaid' });
  const [unreadNotifs, setUnreadNotifs] = useState(0);
  const [chatUnread, setChatUnread] = useState({});
  // Antes la única señal de que llegó algo nuevo era el numerito de la campanita cambiando solo
  // — si no estabas mirando el sidebar en ese momento, no había ningún otro aviso.
  const [toasts, setToasts] = useState([]);
  const toastTimers = useRef({});
  const [editingClient, setEditingClient] = useState(null);
  const [editClientForm, setEditClientForm] = useState({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
  const [editingProject, setEditingProject] = useState(null);
  // La sección de pago del modal de editar cambia de forma según 3 variables (tipo fijo/hora, si
  // sos el propio editor, si Upwork está activo) — nadie que no escribió el código puede predecir
  // qué campos van a aparecer. Colapsada por default para que editar algo simple (deadline,
  // descripción) no obligue a atravesarla, pero arranca abierta si el proyecto ya tiene algo de
  // pago cargado (editor asignado, montos, Upwork, o ya cobrado) para no esconder info existente.
  const [showPaymentSection, setShowPaymentSection] = useState(false);
  const [showCompleteConfirm, setShowCompleteConfirm] = useState(false);
  const [editProjectForm, setEditProjectForm] = useState({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '', material_link: '', payment_editor_id: '', payment_type: 'fixed', payment_amount: '', client_amount: '', payment_hours: '', upwork_status: 'No', upwork_fee_pct: '', client_paid: 'unpaid' });
  const [storageWarning, setStorageWarning] = useState(null); // { gb, bytes } | null
  const [sidebarError, setSidebarError] = useState('');
  const [sidebarRetryCount, setSidebarRetryCount] = useState(0);
  const [expandedClients, setExpandedClients] = useState([]); // string[] de client IDs
  const [searchOpen, setSearchOpen] = useState(false);
  const [expandedCompletedFolders, setExpandedCompletedFolders] = useState([]); // string[] de client IDs con "Terminados" abierto
  const [draggedClientId, setDraggedClientId] = useState(null);
  const [draggedProjectId, setDraggedProjectId] = useState(null);
  const SIDEBAR_MIN = 180, SIDEBAR_MAX = 420;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true');
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = Number(localStorage.getItem('sidebarWidth'));
    return saved >= SIDEBAR_MIN && saved <= SIDEBAR_MAX ? saved : 220;
  });
  const [resizingSidebar, setResizingSidebar] = useState(false);

  // Cmd/Ctrl+K siempre se intercepta, a diferencia del Cmd/Ctrl+Z de deshacer (ver UndoContext) —
  // ahí no tocar el atajo mientras se escribe en un input importa porque pisaría el undo nativo
  // del navegador; acá no hay undo nativo en conflicto, así que abrir la búsqueda con el foco en
  // cualquier campo es justamente el caso de uso (no hay que ir al mouse primero).
  useEffect(() => {
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => { localStorage.setItem('sidebarCollapsed', String(sidebarCollapsed)); }, [sidebarCollapsed]);
  useEffect(() => { localStorage.setItem('sidebarWidth', String(sidebarWidth)); }, [sidebarWidth]);

  // Arrastrar el borde de la sidebar para agrandarla/achicarla — igual que un slider, pero
  // como divisor de panel (el patrón estándar para esto, más cómodo que un <input type="range">).
  useEffect(() => {
    if (!resizingSidebar) return;
    document.body.style.userSelect = 'none';
    const onMove = e => setSidebarWidth(Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, e.clientX)));
    const onUp = () => setResizingSidebar(false);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [resizingSidebar]);
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
    api('/api/notifications/unread-count').then(({ count }) => setUnreadNotifs(count)).catch(console.error);
    api('/api/chat/unread').then(setChatUnread).catch(console.error);
  }, [user?.id, sidebarRetryCount]);

  const dismissToast = (id) => {
    clearTimeout(toastTimers.current[id]);
    delete toastTimers.current[id];
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  // Los timers de toasts pendientes no se limpian solos si el usuario navega/desmonta el layout
  // antes de que se cumplan los 6 segundos — quedarían disparando setState sobre un componente
  // ya desmontado.
  useEffect(() => () => { Object.values(toastTimers.current).forEach(clearTimeout); }, []);

  const openToast = (t) => {
    dismissToast(t.id);
    if (!t.read) api(`/api/notifications/${t.id}/read`, { method: 'PATCH' }).catch(console.error);
    const target = notificationTarget(t);
    if (target) navigate(target);
  };

  useEffect(() => {
    if (!socket) return;
    // Siempre se refresca contra el server (nunca sumando/restando a mano) — así el número
    // converge solo sin importar en cuántas pestañas/dispositivos se lea o llegue una notificación
    // nueva a la vez, en vez de ir arrastrando un contador local que se puede desalinear.
    const refreshUnreadNotifs = () => api('/api/notifications/unread-count').then(({ count }) => setUnreadNotifs(count)).catch(console.error);
    const onNotif = (notif) => {
      refreshUnreadNotifs();
      api('/api/projects').then(setProjects).catch(console.error);
      setToasts(prev => [...prev, notif]);
      toastTimers.current[notif.id] = setTimeout(() => dismissToast(notif.id), TOAST_DURATION_MS);
    };
    const onRead = () => { api('/api/chat/unread').then(setChatUnread).catch(console.error); };
    const onStorageWarn = (s) => setStorageWarning(s);
    const onChatMessage = () => { api('/api/chat/unread').then(setChatUnread).catch(console.error); };
    // Antes el sidebar solo se refrescaba vía notification:new (que no llega a todos los admins,
    // solo al editor asignado) — otro admin no veía un proyecto/cliente nuevo hasta recargar la
    // página a mano. Ahora se actualiza el estado local directo con estos eventos.
    const onProjectCreated = (p) => setProjects(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
    // Mergeado, no reemplazado: el payload de project:updated no trae los campos que agrega
    // GET /api/projects (unread_review_count, task_count), así que pisar la fila entera borraba
    // el punto rojo de "revisión pendiente" con solo editar el proyecto o mover su deadline.
    const onProjectUpdated = (p) => setProjects(prev => prev.some(x => x.id === p.id) ? prev.map(x => x.id === p.id ? { ...x, ...p } : x) : [p, ...prev]);
    const onProjectDeleted = ({ id }) => setProjects(prev => prev.filter(p => p.id !== id));
    const onClientCreated = (c) => setClients(prev => prev.some(x => x.id === c.id) ? prev : [...prev, c].sort((a, b) => a.name.localeCompare(b.name)));
    const onClientUpdated = (c) => setClients(prev => prev.map(x => x.id === c.id ? c : x));
    const onClientDeleted = ({ id }) => setClients(prev => prev.filter(c => c.id !== id));
    // Reordenar (drag & drop) es más simple de refrescar entero que de mergear a mano — no
    // pasa tan seguido como para que valga la pena optimizar el request extra.
    const onClientsReordered = () => api('/api/clients').then(setClients).catch(console.error);
    const onProjectsReordered = () => api('/api/projects').then(setProjects).catch(console.error);
    socket.on('notification:new', onNotif);
    socket.on('notification:read', refreshUnreadNotifs);
    socket.on('notifications:read-all', refreshUnreadNotifs);
    socket.on('chat:read', onRead);
    socket.on('chat:message', onChatMessage);
    socket.on('storage:warning', onStorageWarn);
    socket.on('project:created', onProjectCreated);
    socket.on('project:updated', onProjectUpdated);
    socket.on('project:deleted', onProjectDeleted);
    socket.on('client:created', onClientCreated);
    socket.on('client:updated', onClientUpdated);
    socket.on('client:deleted', onClientDeleted);
    socket.on('clients:reordered', onClientsReordered);
    socket.on('projects:reordered', onProjectsReordered);
    return () => {
      socket.off('notification:new', onNotif); socket.off('notification:read', refreshUnreadNotifs); socket.off('notifications:read-all', refreshUnreadNotifs);
      socket.off('chat:read', onRead); socket.off('chat:message', onChatMessage); socket.off('storage:warning', onStorageWarn);
      socket.off('project:created', onProjectCreated); socket.off('project:updated', onProjectUpdated); socket.off('project:deleted', onProjectDeleted);
      socket.off('client:created', onClientCreated); socket.off('client:updated', onClientUpdated); socket.off('client:deleted', onClientDeleted);
      socket.off('clients:reordered', onClientsReordered); socket.off('projects:reordered', onProjectsReordered);
    };
  }, [socket]);

  const openNewProject = () => { setStep(1); setProjectForm({ name: '', description: '', color: '#6366f1', client_id: '', deadline: '', material_link: '' }); setPaymentForm({ payment_editor_id: '', payment_type: 'fixed', payment_amount: '', payment_rate: '', payment_hours: '', client_amount: '', client_rate: '', upwork_status: 'No', upwork_fee_pct: '', client_paid: 'unpaid' }); setShowNewProject(true); };

  const createClient = async () => {
    if (!clientForm.name.trim() || isCreatingClient) return;
    setIsCreatingClient(true);
    try {
      await api('/api/clients', { method: 'POST', body: clientForm });
      const updated = await api('/api/clients');
      setClients(updated);
      setShowNewClient(false);
      setClientForm({ name: '', color: '#6366f1', email: '', phone: '', notes: '' });
    } catch (e) {
      console.error('Error creando cliente:', e);
      await alert('Error: ' + e.message);
    } finally {
      setIsCreatingClient(false);
    }
  };

  // taskIdsToReassign: se aplican recién si el guardado del proyecto en sí sale bien — nada de
  // esto se toca si el PUT del proyecto falla o si el usuario cancela antes de llegar acá.
  const doSaveProject = async (taskIdsToReassign = []) => {
    const clientPaidChanged = editProjectForm.client_paid !== (editingProject.client_paid === 'cobrado' ? 'cobrado' : 'unpaid');
    try {
      const isSelf = editProjectForm.payment_editor_id === ownerUserId;
      const body = { ...editingProject, ...editProjectForm, payment_amount: isSelf ? 0 : editProjectForm.payment_amount };
      let updated = await api(`/api/projects/${editingProject.id}`, { method: 'PUT', body });
      // client_paid necesita pasar por el endpoint de Pagos para "congelar" el monto real en
      // ese momento (ver PATCH /api/payments/:id) — el PUT genérico de arriba lo ignora a propósito.
      if (clientPaidChanged) {
        updated = await api(`/api/payments/${editingProject.id}`, { method: 'PATCH', body: { client_paid: editProjectForm.client_paid } });
      }
      if (taskIdsToReassign.length > 0) {
        const newEditorId = editProjectForm.payment_editor_id;
        await Promise.all(taskIdsToReassign.map(tid => api(`/api/tasks/${tid}`, { method: 'PUT', body: { assigned_to: newEditorId } })));
      }
      setProjects(prev => prev.map(p => p.id === editingProject.id ? { ...p, ...updated } : p));
      setEditingProject(null);
    } catch (e) { console.error(e); await alert('Error: ' + e.message); }
  };

  // Cambiar el editor del proyecto (campo usado para el pago) NUNCA mueve las tareas ya asignadas
  // al editor anterior — quedan donde estaban. Eso puede dejar un estado confuso (el editor nuevo
  // no ve ninguna tarea, el viejo sigue viendo las suyas), así que se pregunta tarea por tarea en
  // vez de mover todo automáticamente o no mover nada en silencio — con un atajo para el caso
  // común de "sí, todas". Las respuestas se acumulan en memoria nada más (ningún PUT de tarea
  // hasta el final): si el cambio de editor del proyecto se termina cancelando, no puede quedar
  // ninguna tarea reasignada sin que el proyecto en sí haya cambiado.
  // reassignReview: { tasks, index, selected, newEditorId, oldName, newName, resolve }.
  const [reassignReview, setReassignReview] = useState(null);

  // Devuelve una Promise: null si se canceló (la "✕" — no guardar nada de nada), o un array con
  // los ids de las tareas a reasignar (puede ser vacío) para que doSaveProject los aplique junto
  // con el guardado del proyecto.
  const reassignOldEditorTasks = () => new Promise(async (resolve) => {
    const oldEditorId = editingProject.payment_editor_id || '';
    const newEditorId = editProjectForm.payment_editor_id || '';
    if (!newEditorId || !oldEditorId || newEditorId === oldEditorId) return resolve([]);
    let tasks;
    try {
      tasks = await api(`/api/projects/${editingProject.id}/tasks`);
    } catch (e) { console.error('Error chequeando tareas del proyecto:', e); return resolve([]); }
    const oldEditorTasks = tasks.filter(t => t.assigned_to === oldEditorId);
    if (oldEditorTasks.length === 0) return resolve([]);
    setReassignReview({
      tasks: oldEditorTasks, index: 0, selected: [], newEditorId,
      oldName: editingProject.payment_editor_name || 'el editor anterior',
      newName: users.find(u => u.id === newEditorId)?.name || 'el nuevo editor',
      resolve,
    });
  });

  // result=null (la "✕") cancela todo — ni el proyecto ni ninguna tarea se tocan.
  const finishReassignReview = (result) => { reassignReview.resolve(result); setReassignReview(null); };

  const reassignCurrentAndAdvance = (accept) => {
    const { tasks, index, selected } = reassignReview;
    const nextSelected = accept ? [...selected, tasks[index].id] : selected;
    if (index + 1 >= tasks.length) finishReassignReview(nextSelected);
    else setReassignReview({ ...reassignReview, index: index + 1, selected: nextSelected });
  };

  const reassignAllRemaining = () => {
    const { tasks, index, selected } = reassignReview;
    finishReassignReview([...selected, ...tasks.slice(index).map(t => t.id)]);
  };

  // Pasar a "Completados" no debería ser automático — se pide confirmación (con el modal propio
  // de la app) solo cuando guardar haría que AMBOS lados (editor y cliente) queden saldados.
  const saveProject = async () => {
    if (!editProjectForm.name.trim()) return;
    const clientPaidChanged = editProjectForm.client_paid !== (editingProject.client_paid === 'cobrado' ? 'cobrado' : 'unpaid');
    if (clientPaidChanged && editProjectForm.client_paid === 'cobrado') {
      const isSelf = editProjectForm.payment_editor_id === ownerUserId;
      const editorSettled = isSelf || editingProject.editor_paid === 'paid';
      if (editingProject.status === 'completed' && editorSettled) {
        setShowCompleteConfirm(true);
        return;
      }
    }
    const taskIdsToReassign = await reassignOldEditorTasks();
    if (taskIdsToReassign === null) return;
    doSaveProject(taskIdsToReassign);
  };

  const saveClient = async () => {
    if (!editClientForm.name.trim()) return;
    try {
      await api(`/api/clients/${editingClient.id}`, { method: 'PATCH', body: editClientForm });
      const updated = await api('/api/clients');
      setClients(updated);
      setEditingClient(null);
    } catch (e) { console.error(e); await alert('Error: ' + e.message); }
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

  const deleteProject = (id) => {
    const project = projects.find(p => p.id === id);
    if (!project) return;
    setProjects(prev => prev.filter(p => p.id !== id));
    if (location.pathname === `/project/${id}`) navigate('/');
    scheduleDelete(`Proyecto "${project.name}" eliminado`, {
      onCommit: () => api(`/api/projects/${id}`, { method: 'DELETE' }),
      onUndo: () => setProjects(prev => [project, ...prev])
    });
  };

  const openEditProject = (p) => {
    setEditingProject(p);
    setEditProjectForm({ name: p.name, description: p.description || '', color: p.color, client_id: p.client_id || '', deadline: p.deadline || '', material_link: p.material_link || '', payment_editor_id: p.payment_editor_id || '', payment_type: p.payment_type || 'fixed', payment_amount: p.payment_amount || '', client_amount: p.client_amount || '', payment_hours: p.payment_hours || '', upwork_status: (p.upwork_status === 'Pendiente de carga' || p.upwork_status === 'Cargado') ? p.upwork_status : 'No', upwork_fee_pct: p.upwork_fee_pct ?? '', client_paid: p.client_paid === 'cobrado' ? 'cobrado' : 'unpaid' });
    const hasPaymentData = !!(p.payment_editor_id || Number(p.payment_amount) > 0 || Number(p.client_amount) > 0 || p.client_paid === 'cobrado' || (p.upwork_status && p.upwork_status !== 'No'));
    setShowPaymentSection(hasPaymentData);
  };

  // Clona cliente/editor/config de pago y las tareas (título, descripción, prioridad, asignado —
  // sin fechas ni nada de plata ya cobrada/pagada) para el caso recurrente de "otro proyecto
  // igual al anterior". Mismo guard de dedupe contra el socket que createProject, y misma
  // decisión de navegar directo al nuevo proyecto para que el admin lo revise/ajuste de una.
  const duplicateProject = async (p) => {
    try {
      const created = await api(`/api/projects/${p.id}/duplicate`, { method: 'POST' });
      setProjects(prev => prev.some(x => x.id === created.id) ? prev : [created, ...prev]);
      navigate(`/project/${created.id}`);
    } catch (e) {
      console.error('Error duplicando proyecto:', e);
      await alert('Error: ' + e.message);
    }
  };

  const deleteClient = (c) => {
    setClients(prev => prev.filter(x => x.id !== c.id));
    scheduleDelete(`Cliente "${c.name}" eliminado`, {
      onCommit: () => api(`/api/clients/${c.id}`, { method: 'DELETE' }),
      onUndo: () => setClients(prev => [...prev, c])
    });
  };

  // Reordena clientes por drag & drop: mueve el arrastrado a la posición del que recibió el
  // drop, actualiza el sidebar al toque, y persiste el orden completo en el servidor.
  const reorderClients = (draggedId, targetId) => {
    if (draggedId === targetId) return;
    setClients(prev => {
      const arr = [...prev];
      const fromIdx = arr.findIndex(c => c.id === draggedId);
      const toIdx = arr.findIndex(c => c.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      api('/api/clients/reorder', { method: 'PATCH', body: { order: arr.map(c => c.id) } }).catch(console.error);
      return arr;
    });
  };

  // Mismo patrón pero acotado a los proyectos de UN cliente (o sin cliente) — el resto de
  // `projects` no se toca, solo se reordena el subgrupo y se manda su nuevo orden.
  const reorderProjects = (clientId, draggedId, targetId) => {
    if (draggedId === targetId) return;
    setProjects(prev => {
      const inGroup = prev.filter(p => (p.client_id || null) === clientId);
      const others = prev.filter(p => (p.client_id || null) !== clientId);
      const fromIdx = inGroup.findIndex(p => p.id === draggedId);
      const toIdx = inGroup.findIndex(p => p.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [moved] = inGroup.splice(fromIdx, 1);
      inGroup.splice(toIdx, 0, moved);
      api('/api/projects/reorder', { method: 'PATCH', body: { order: inGroup.map(p => p.id) } }).catch(console.error);
      return [...others, ...inGroup];
    });
  };

  const goToStep2 = () => { if (!projectForm.name.trim()) return; setStep(2); };

  const createProject = async () => {
    // Sin este guard, una respuesta lenta del server (ej: cold start en el free tier de Render)
    // + un segundo click por impaciencia terminaba creando el proyecto duplicado.
    if (isCreatingProject) return;
    setIsCreatingProject(true);
    try {
      const body = { ...projectForm };
      if (user?.role === 'admin') {
        const isSelf = paymentForm.payment_editor_id === ownerUserId;
        body.payment_editor_id = paymentForm.payment_editor_id || null;
        body.payment_type = paymentForm.payment_type;
        // El pago al editor se puede cargar aunque todavía no se haya asignado a nadie — solo se
        // guarda en 0 cuando el editor es el dueño de la agencia (ahí sí no hay pago real que
        // registrar; no aplica a cualquier admin, solo a esa cuenta específica).
        body.payment_amount = isSelf ? 0 : (paymentForm.payment_type === 'fixed' ? paymentForm.payment_amount : paymentForm.payment_rate);
        body.payment_hours = paymentForm.payment_hours || 0;
        body.client_amount = paymentForm.payment_type === 'fixed' ? paymentForm.client_amount : paymentForm.client_rate;
        body.upwork_status = paymentForm.upwork_status;
        body.upwork_fee_pct = paymentForm.upwork_fee_pct;
      }
      let p = await api('/api/projects', { method: 'POST', body });
      // client_paid necesita pasar por el endpoint de Pagos para "congelar" el monto real en
      // ese momento (ver PATCH /api/payments/:id) — el POST de arriba lo ignora a propósito.
      if (paymentForm.client_paid === 'cobrado') {
        p = await api(`/api/payments/${p.id}`, { method: 'PATCH', body: { client_paid: 'cobrado' } });
      }
      // El socket 'project:created' (emitido a todos los admins, incluido quien lo creó) puede
      // llegar antes que esta respuesta HTTP se resuelva — sin este chequeo, el mismo proyecto
      // termina agregado dos veces a la lista local aunque en la base exista una sola fila.
      setProjects(prev => prev.some(x => x.id === p.id) ? prev : [p, ...prev]);
      setShowNewProject(false);
      navigate(`/project/${p.id}`);
    } catch (e) {
      console.error('Error creando proyecto:', e);
      await alert('Error: ' + e.message);
    } finally {
      setIsCreatingProject(false);
    }
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
  // Cuando se cobra por Upwork, lo que realmente llega a la cuenta es el cobro al cliente menos
  // la comisión de la plataforma — el "Cobro cliente" que carga el admin es el bruto.
  const estimatedClientNet = () => {
    const gross = estimatedClientTotal();
    if (paymentForm.upwork_status === 'No') return gross;
    return gross * (1 - (parseFloat(paymentForm.upwork_fee_pct) || 0) / 100);
  };
  // Cuando el editor asignado es el dueño de la agencia, "pago a editor" no es un gasto real (no
  // se paga a sí mismo) — se oculta ese campo y solo se pide el cobro al cliente. Por id fijo del
  // dueño (ownerUserId), no por "quién está logueado ahora": un segundo admin asignando a otro
  // admin como editor no debería ocultar el campo, ese sí es un pago real a trackear.
  const isSelfEditorNew = paymentForm.payment_editor_id === ownerUserId;
  // El pago al editor se puede cargar de antemano aunque todavía no se haya elegido quién es
  // (se asigna después) — solo se oculta cuando el editor elegido es el dueño de la agencia, ahí
  // sí no hay pago real que registrar.
  const showEditorPaymentNew = !isSelfEditorNew;
  const isSelfEditorEdit = editProjectForm.payment_editor_id === ownerUserId;
  // Una vez que un lado ya se cobró/pagó, el monto queda congelado en su propia columna (ver
  // PATCH /api/payments/:id) — pero el campo de origen (client_amount/payment_amount/
  // payment_hours) seguía editable sin ningún aviso. No cambia el monto YA congelado, pero sí el
  // que se recalcularía si algún día se desmarca y se vuelve a marcar ese lado — un valor distinto
  // al original, sin ninguna señal de que pasó. Se bloquean para forzar a desmarcar primero si
  // hace falta corregir algo, en vez de dejarlo drifting en silencio.
  const clientAmountLocked = editProjectForm.client_paid === 'cobrado';
  const editorAmountLocked = editingProject?.editor_paid === 'paid';

  // Fila de un proyecto dentro del sidebar — la usan tanto la lista de activos como la subcarpeta
  // "Terminados" de cada cliente, con distinto indent para reflejar el anidado.
  const renderSidebarProjectRow = (p, clientId, indent = 26) => (
    <div key={p.id} className="sidebar-row" style={{ display: 'flex', alignItems: 'center', borderRadius: 7, marginBottom: 1, background: isProjectActive(p.id) ? 'var(--bg3)' : 'transparent', transition: 'all 0.1s', opacity: draggedProjectId === p.id ? 0.4 : (p.status === 'completed' ? 0.55 : 1) }}
      draggable={user?.role === 'admin'}
      onDragStart={e => { e.stopPropagation(); setDraggedProjectId(p.id); }}
      onDragOver={e => { if (user?.role === 'admin' && draggedProjectId) e.preventDefault(); }}
      onDrop={e => { if (draggedProjectId) { e.preventDefault(); e.stopPropagation(); reorderProjects(clientId, draggedProjectId, p.id); } }}
      onDragEnd={() => setDraggedProjectId(null)}>
      <Link to={`/project/${p.id}`} style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: `4px 10px 4px ${indent}px`, cursor: 'pointer', color: isProjectActive(p.id) ? 'var(--text)' : 'var(--text2)', fontSize: 11.5 }}>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: p.color, flexShrink: 0, opacity: 0.8 }} />
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          {p.status === 'completed' && <span title="Terminado" style={{ fontSize: 10, flexShrink: 0 }}>✅</span>}
          {user?.role === 'admin' && p.unread_review_count > 0 && (
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
          )}
        </div>
      </Link>
      {user?.role === 'admin' && (
        <ProjectRowActions fontSize={12} padding="5px 4px"
          onDuplicate={e => { e.preventDefault(); duplicateProject(p); }}
          onEdit={e => { e.preventDefault(); openEditProject(p); }}
          onDelete={e => { e.preventDefault(); deleteProject(p.id); }} />
      )}
    </div>
  );

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: 'var(--bg)' }}>
      {/* Sidebar */}
      {!sidebarCollapsed && (
      <aside style={{ width: sidebarWidth, background: 'var(--bg2)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>
        <div style={{ padding: '16px 14px 12px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 30, height: 30, background: 'var(--accent)', borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 }}>🎬</div>
          <span style={{ fontFamily: 'var(--font-display)', fontWeight: 800, fontSize: 18, letterSpacing: '-0.02em', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>AgencyOS</span>
          <button onClick={() => setSidebarCollapsed(true)} title="Ocultar sidebar" style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 15, padding: 4, flexShrink: 0 }}>◀</button>
        </div>

        <div style={{ padding: '10px 8px 0' }}>
          <button onClick={() => setSearchOpen(true)} style={{
            display: 'flex', alignItems: 'center', gap: 7, width: '100%', padding: '7px 10px', marginBottom: 6,
            background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer',
            color: 'var(--text3)', fontSize: 12.5, fontFamily: 'var(--font)'
          }}>
            <span>🔍</span>
            <span style={{ flex: 1, textAlign: 'left' }}>Buscar...</span>
            <span style={{ fontSize: 10.5, border: '1px solid var(--border2)', borderRadius: 4, padding: '1px 5px' }}>
              {navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K'}
            </span>
          </button>
        </div>

        <div style={{ padding: '6px 8px 6px' }}>
          <SideLabel>General</SideLabel>
          <NavItem to="/" label="Dashboard" icon="🏠" active={isActive('/')} />
          <NavItem to="/calendar" label="Calendario" icon="📅" active={isActive('/calendar')} />
          <NavItem to="/chat" label="Chat" icon="💬" active={isActive('/chat')} badge={Object.values(chatUnread).reduce((a, b) => a + b, 0)} />
          <NavItem to="/team" label="Equipo" icon="👥" active={isActive('/team')} />
          <NavItem to="/notifications" label="Notificaciones" icon="🔔" active={isActive('/notifications')} badge={unreadNotifs} badgeRed />
          {/* El admin ya ve todo esto (y más) en Pagos — este link self-scoped es para el
              editor, que hoy no tiene ninguna forma de ver ni su propia tarifa. */}
          {user?.role !== 'admin' && (
            <NavItem to="/earnings" label="Mis ganancias" icon="💵" active={isActive('/earnings')} />
          )}
          {user?.role === 'admin' && (
            <>
              <NavItem to="/videos" label="Videos" icon="🎬" active={isActive('/videos')} admin />
              <NavItem to="/payments" label="Pagos" icon="💰" active={isActive('/payments')} admin />
            </>
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
              <button className="btn-retry btn-retry-sm" onClick={() => setSidebarRetryCount(c => c + 1)}>Reintentar</button>
            </div>
          )}

          {/* Projects grouped by client — click to expand */}
          {clients.map(c => {
            const clientProjects = projects.filter(p => p.client_id === c.id);
            const activeProjects = clientProjects.filter(p => p.status !== 'completed');
            const completedProjects = clientProjects.filter(p => p.status === 'completed');
            const isExpanded = expandedClients.includes(c.id);
            const isCompletedExpanded = expandedCompletedFolders.includes(c.id);
            return (
              <div key={c.id} style={{ marginBottom: 2, opacity: draggedClientId === c.id ? 0.4 : 1 }}>
                <div className="sidebar-row" style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 7, cursor: 'pointer', transition: 'background 0.1s' }}
                  draggable={user?.role === 'admin'}
                  onDragStart={() => setDraggedClientId(c.id)}
                  onDragOver={e => { if (user?.role === 'admin' && draggedClientId) e.preventDefault(); }}
                  onDrop={e => { if (draggedClientId) { e.preventDefault(); reorderClients(draggedClientId, c.id); } }}
                  onDragEnd={() => setDraggedClientId(null)}
                  onClick={() => setExpandedClients(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}
                  onDoubleClick={e => { e.stopPropagation(); navigate(`/client/${c.id}`); }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg3)'; }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}>
                  <span style={{ fontSize: 10, color: 'var(--text3)', transition: 'transform 0.15s', display: 'inline-block', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>▶</span>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                  <span style={{ fontSize: 15.6, fontWeight: 900, color: 'var(--text2)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.name}</span>
                  {user?.role === 'admin' && clientProjects.some(p => p.unread_review_count > 0) && (
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                  )}
                  {activeProjects.length > 0 && <span style={{ fontSize: 10, color: 'var(--text3)' }}>{activeProjects.length}</span>}
                  {user?.role === 'admin' && (
                    <ProjectRowActions fontSize={12} padding="1px 4px"
                      onEdit={e => { e.stopPropagation(); setEditingClient(c); setEditClientForm({ name: c.name, color: c.color, email: c.email || '', phone: c.phone || '', notes: c.notes || '' }); }}
                      onDelete={e => { e.stopPropagation(); deleteClient(c); }} />
                  )}
                </div>
                {isExpanded && activeProjects.map(p => renderSidebarProjectRow(p, c.id))}
                {isExpanded && completedProjects.length > 0 && (
                  <>
                    <div className="sidebar-row" style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px 4px 26px', borderRadius: 7, cursor: 'pointer', fontSize: 11.5, color: 'var(--text3)' }}
                      onClick={() => setExpandedCompletedFolders(prev => prev.includes(c.id) ? prev.filter(id => id !== c.id) : [...prev, c.id])}>
                      <span style={{ fontSize: 9, transition: 'transform 0.15s', display: 'inline-block', transform: isCompletedExpanded ? 'rotate(90deg)' : 'rotate(0deg)', flexShrink: 0 }}>▶</span>
                      <span style={{ flex: 1 }}>📁 Terminados</span>
                      <span style={{ fontSize: 10 }}>{completedProjects.length}</span>
                    </div>
                    {isCompletedExpanded && completedProjects.map(p => renderSidebarProjectRow(p, c.id, 38))}
                  </>
                )}
                {isExpanded && clientProjects.length === 0 && (
                  <div style={{ padding: '4px 10px 4px 26px', fontSize: 11, color: 'var(--text3)', fontStyle: 'italic' }}>Sin proyectos aún</div>
                )}
              </div>
            );
          })}

          {/* Projects without client */}
          {projects.filter(p => !p.client_id).map(p => (
            <div key={p.id} className="sidebar-row" style={{ display: 'flex', alignItems: 'center', borderRadius: 7, marginBottom: 1, background: isProjectActive(p.id) ? 'var(--bg3)' : 'transparent', transition: 'all 0.1s', opacity: draggedProjectId === p.id ? 0.4 : (p.status === 'completed' ? 0.55 : 1) }}
              draggable={user?.role === 'admin'}
              onDragStart={() => setDraggedProjectId(p.id)}
              onDragOver={e => { if (user?.role === 'admin' && draggedProjectId) e.preventDefault(); }}
              onDrop={e => { if (draggedProjectId) { e.preventDefault(); reorderProjects(null, draggedProjectId, p.id); } }}
              onDragEnd={() => setDraggedProjectId(null)}>
              <Link to={`/project/${p.id}`} style={{ textDecoration: 'none', flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', cursor: 'pointer', color: isProjectActive(p.id) ? 'var(--text)' : 'var(--text2)', fontSize: 13 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: p.color, flexShrink: 0 }} />
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                  {p.status === 'completed' && <span title="Terminado" style={{ fontSize: 10, flexShrink: 0 }}>✅</span>}
                  {user?.role === 'admin' && p.unread_review_count > 0 && (
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)', flexShrink: 0 }} />
                  )}
                </div>
              </Link>
              {user?.role === 'admin' && (
                <ProjectRowActions fontSize={13} padding="6px 4px"
                  onDuplicate={e => { e.preventDefault(); duplicateProject(p); }}
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
      )}

      {!sidebarCollapsed && (
        <div
          onMouseDown={() => setResizingSidebar(true)}
          title="Arrastrar para cambiar el ancho"
          style={{ width: 5, flexShrink: 0, cursor: 'col-resize', background: resizingSidebar ? 'var(--accent)' : 'transparent' }}
        />
      )}

      {sidebarCollapsed && (
        <button onClick={() => setSidebarCollapsed(false)} title="Mostrar sidebar" style={{
          position: 'fixed', left: 10, top: 12, zIndex: 50, width: 32, height: 32, borderRadius: 8,
          background: 'var(--bg2)', border: '1px solid var(--border)', color: 'var(--text2)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14
        }}>▶</button>
      )}

      <main style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        {storageWarning && user?.role === 'admin' && (
          <div style={{ background: 'rgba(240,168,58,0.08)', borderBottom: '1px solid rgba(240,168,58,0.31)', padding: '8px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>⚠️</span>
              <span style={{ fontSize: 13, color: 'var(--yellow)', fontWeight: 600 }}>Almacenamiento: {storageWarning.gb} GB usados</span>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>— Superaste los 20GB. Considerá borrar archivos viejos o migrar a la nube.</span>
            </div>
            <button onClick={() => setStorageWarning(null)} style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 14, padding: '0 4px' }}>✕</button>
          </div>
        )}
        {/* Va acá adentro y no solo en App.jsx para que un error en una pantalla deje el sidebar
            en pie y se pueda navegar a otra. La key por pathname lo resetea al cambiar de ruta:
            si no, una vez que una pantalla rompe, el fallback queda pegado para todas. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet context={{ projects, setProjects, unreadNotifs, setUnreadNotifs, openEditProject }} />
        </ErrorBoundary>
      </main>

      <SearchPalette open={searchOpen} onClose={() => setSearchOpen(false)} />

      {/* New Project Modal */}
      {showNewProject && (
        <div className="modal-overlay">
          <div className="modal modal-lg" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowNewProject(false)} title="Cerrar">✕</button>

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
                    <select className="input" value={projectForm.client_id} onChange={e => {
                      const clientId = e.target.value;
                      const client = clients.find(c => c.id === clientId);
                      // El color del proyecto arranca igual al del cliente elegido — se puede
                      // cambiar después con los círculos de abajo, esto es solo el default.
                      setProjectForm(p => ({ ...p, client_id: clientId, color: client?.color || p.color }));
                    }}>
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
                  <label>Link al material (opcional)</label>
                  <input className="input" type="url" value={projectForm.material_link} onChange={e => setProjectForm(p => ({ ...p, material_link: e.target.value }))} placeholder="Ej: link a Drive con el material" />
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
                    : <button className="btn btn-primary" onClick={createProject} disabled={!projectForm.name.trim() || isCreatingProject}>{isCreatingProject ? 'Creando...' : 'Crear proyecto'}</button>
                  }
                </div>
              </>
            )}

            {/* Step 2 — pago (solo admin) */}
            {step === 2 && user?.role === 'admin' && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
                  <h2>Paso 2 — Configuración de pago</h2>
                  <button type="button" onClick={createProject} disabled={isCreatingProject}
                    style={{ background: 'transparent', border: 'none', color: 'var(--accent2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)', whiteSpace: 'nowrap' }}>
                    Omitir por ahora →
                  </button>
                </div>
                <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--yellow)' }}>
                  🔒 Esta información es solo visible para vos — es opcional, se puede cargar después desde "Editar proyecto"
                </div>
                <div className="form-group">
                  <label>Editor responsable del pago</label>
                  <select className="input" value={paymentForm.payment_editor_id} onChange={e => setPaymentForm(p => ({ ...p, payment_editor_id: e.target.value }))}>
                    <option value="">Sin asignar (opcional, lo podés agregar después)</option>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>{u.name}{u.id === user.id ? ' (vos)' : ''}</option>
                    ))}
                  </select>
                </div>
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
                    <div className="form-group">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                        <input type="checkbox" checked={paymentForm.upwork_status !== 'No'}
                          onChange={e => setPaymentForm(p => ({ ...p, upwork_status: e.target.checked ? 'Pendiente de carga' : 'No', upwork_fee_pct: e.target.checked ? (p.upwork_fee_pct || 15) : '' }))} />
                        Se cobra al cliente por Upwork
                      </label>
                      <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                        Solo afecta lo que se le cobra al cliente — el pago al editor nunca cambia por esto.
                      </div>
                      {paymentForm.upwork_status !== 'No' && (
                        <div style={{ marginTop: 8 }}>
                          <label>% comisión que descuenta Upwork</label>
                          <input className="input" type="number" min="0" max="100" value={paymentForm.upwork_fee_pct}
                            onChange={e => setPaymentForm(p => ({ ...p, upwork_fee_pct: e.target.value }))} placeholder="Ej: 15" />
                        </div>
                      )}
                    </div>
                    <div className="form-group">
                      <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                        <input type="checkbox" checked={paymentForm.client_paid === 'cobrado'}
                          onChange={e => setPaymentForm(p => ({ ...p, client_paid: e.target.checked ? 'cobrado' : 'unpaid' }))} />
                        El cliente ya pagó este proyecto
                      </label>
                    </div>
                    {!showEditorPaymentNew && (
                      <div style={{ background: 'var(--bg3)', border: '1px dashed var(--border2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: 'var(--text2)' }}>
                        Como el editor sos vos, no hay "pago a editor" — solo se registra lo que le cobrás al cliente.
                      </div>
                    )}
                    {paymentForm.payment_type === 'fixed' ? (
                      <div className="form-row" style={!showEditorPaymentNew ? { gridTemplateColumns: '1fr' } : undefined}>
                        <div className="form-group">
                          <label>Cobro al cliente ($)</label>
                          <input className="input" type="number" min="0" value={paymentForm.client_amount} onChange={e => setPaymentForm(p => ({ ...p, client_amount: e.target.value }))} placeholder="Ej: 800" />
                        </div>
                        {showEditorPaymentNew && (
                          <div className="form-group">
                            <label>Pago al editor ($)</label>
                            <input className="input" type="number" min="0" value={paymentForm.payment_amount} onChange={e => setPaymentForm(p => ({ ...p, payment_amount: e.target.value }))} placeholder="Ej: 500 (opcional, lo podés agregar después)" />
                          </div>
                        )}
                      </div>
                    ) : (
                      <>
                        <div className="form-row" style={!showEditorPaymentNew ? { gridTemplateColumns: '1fr' } : undefined}>
                          <div className="form-group">
                            <label>Tarifa cliente ($/h)</label>
                            <input className="input" type="number" min="0" value={paymentForm.client_rate} onChange={e => setPaymentForm(p => ({ ...p, client_rate: e.target.value }))} placeholder="Ej: 40" />
                          </div>
                          {showEditorPaymentNew && (
                            <div className="form-group">
                              <label>Tarifa editor ($/h)</label>
                              <input className="input" type="number" min="0" value={paymentForm.payment_rate} onChange={e => setPaymentForm(p => ({ ...p, payment_rate: e.target.value }))} placeholder="Ej: 25 (opcional, lo podés agregar después)" />
                            </div>
                          )}
                        </div>
                        <div className="form-group">
                          <label>Horas estimadas</label>
                          <input className="input" type="number" min="0" value={paymentForm.payment_hours} onChange={e => setPaymentForm(p => ({ ...p, payment_hours: e.target.value }))} placeholder="Ej: 20" />
                        </div>
                      </>
                    )}
                    {(!showEditorPaymentNew ? estimatedClientTotal() > 0 : (estimatedTotal() > 0 || estimatedClientTotal() > 0)) && (
                      <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {showEditorPaymentNew && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 12, color: 'var(--pink)' }}>Pago editor:</span>
                            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--pink)' }}>${estimatedTotal().toFixed(0)}</span>
                          </div>
                        )}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 12, color: 'var(--lavender)' }}>Cobro cliente (bruto):</span>
                          <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--lavender)' }}>${estimatedClientTotal().toFixed(0)}</span>
                        </div>
                        {paymentForm.upwork_status !== 'No' && (
                          <>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: 12, color: 'var(--text3)' }}>Comisión Upwork ({paymentForm.upwork_fee_pct || 0}%):</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text3)' }}>-${(estimatedClientTotal() - estimatedClientNet()).toFixed(0)}</span>
                            </div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ fontSize: 12, color: 'var(--lavender)' }}>Recibís (neto):</span>
                              <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--lavender)' }}>${estimatedClientNet().toFixed(0)}</span>
                            </div>
                          </>
                        )}
                        {showEditorPaymentNew && estimatedClientNet() > estimatedTotal() && (
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                            <span style={{ fontSize: 12, color: 'var(--green)' }}>Ganancia:</span>
                            <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>${(estimatedClientNet() - estimatedTotal()).toFixed(0)}</span>
                          </div>
                        )}
                      </div>
                    )}
                  </>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button className="btn btn-ghost" onClick={() => setStep(1)}>← Volver</button>
                  <button className="btn btn-primary" onClick={createProject} disabled={isCreatingProject}>{isCreatingProject ? 'Creando...' : 'Crear proyecto'}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {showNewClient && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowNewClient(false)} title="Cerrar">✕</button>
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
              <button className="btn btn-primary" onClick={createClient} disabled={!clientForm.name.trim() || isCreatingClient}>{isCreatingClient ? 'Creando...' : 'Crear cliente'}</button>
            </div>
          </div>
        </div>
      )}
      {editingProject && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setEditingProject(null)} title="Cerrar">✕</button>
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
            <div className="form-group">
              <label>Link al material (opcional)</label>
              <input className="input" type="url" value={editProjectForm.material_link} onChange={e => setEditProjectForm(p => ({ ...p, material_link: e.target.value }))} placeholder="Ej: link a Drive con el material" />
            </div>
            {user?.role === 'admin' && (
              <div className="form-group" style={{ borderTop: '1px solid var(--border)', paddingTop: 14 }}>
                <button type="button" onClick={() => setShowPaymentSection(s => !s)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--accent2)', fontSize: 13, fontWeight: 600, fontFamily: 'var(--font)' }}>
                  <span style={{ display: 'inline-block', transform: showPaymentSection ? 'rotate(90deg)' : 'none', transition: 'transform 0.15s' }}>▸</span>
                  Configuración de pago
                </button>
              </div>
            )}
            {user?.role === 'admin' && showPaymentSection && (
              <>
                <div className="form-group">
                  <label>Editor asignado</label>
                  <select className="input" value={editProjectForm.payment_editor_id} onChange={e => setEditProjectForm(p => ({ ...p, payment_editor_id: e.target.value }))}>
                    <option value="">Sin asignar</option>
                    {users.map(u => (
                      <option key={u.id} value={u.id}>{u.name}{u.id === user.id ? ' (vos)' : ''}</option>
                    ))}
                  </select>
                </div>
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
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                    <input type="checkbox" checked={editProjectForm.upwork_status !== 'No'}
                      onChange={e => setEditProjectForm(p => ({ ...p, upwork_status: e.target.checked ? 'Pendiente de carga' : 'No', upwork_fee_pct: e.target.checked ? (p.upwork_fee_pct || 15) : '' }))} />
                    Se cobra al cliente por Upwork
                  </label>
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                    Solo afecta lo que se le cobra al cliente — el pago al editor nunca cambia por esto.
                  </div>
                  {editProjectForm.upwork_status !== 'No' && (
                    <div style={{ marginTop: 8 }}>
                      <label>% comisión que descuenta Upwork</label>
                      <input className="input" type="number" min="0" max="100" value={editProjectForm.upwork_fee_pct}
                        onChange={e => setEditProjectForm(p => ({ ...p, upwork_fee_pct: e.target.value }))} placeholder="Ej: 15" />
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                    <input type="checkbox" checked={editProjectForm.client_paid === 'cobrado'}
                      onChange={async e => {
                        // Desmarcar no deja rastro de cuándo se había marcado la primera vez —
                        // client_paid_at se pisa al volver a marcarlo, así que puede terminar
                        // contando en un mes distinto (con un monto distinto si cambió algo
                        // mientras tanto) sin ningún aviso.
                        if (!e.target.checked && editingProject?.client_paid === 'cobrado') {
                          const ok = await confirm('Vas a desmarcar "el cliente ya pagó". Si lo volvés a marcar más adelante, va a contar en el mes en que lo vuelvas a marcar (no en el original). ¿Continuar?', { confirmText: 'Desmarcar', danger: true });
                          if (!ok) return;
                        }
                        setEditProjectForm(p => ({ ...p, client_paid: e.target.checked ? 'cobrado' : 'unpaid' }));
                      }} />
                    El cliente ya pagó este proyecto
                  </label>
                </div>
                {isSelfEditorEdit && (
                  <div style={{ background: 'var(--bg3)', border: '1px dashed var(--border2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: 'var(--text2)' }}>
                    Como el editor sos vos, no hay "pago a editor" — solo se registra lo que le cobrás al cliente.
                  </div>
                )}
                <div style={{ display: 'grid', gridTemplateColumns: isSelfEditorEdit ? (editProjectForm.payment_type === 'hourly' ? '1fr 1fr' : '1fr') : (editProjectForm.payment_type === 'hourly' ? '1fr 1fr 1fr' : '1fr 1fr'), gap: 10 }}>
                  <div className="form-group">
                    <label>{editProjectForm.payment_type === 'hourly' ? 'Tarifa cliente ($/h)' : 'Cobro al cliente ($)'}</label>
                    <input className="input" type="number" min="0" value={editProjectForm.client_amount} disabled={clientAmountLocked}
                      title={clientAmountLocked ? 'Ya se cobró con este monto — desmarcá "el cliente ya pagó" para poder corregirlo' : undefined}
                      onChange={e => setEditProjectForm(p => ({ ...p, client_amount: e.target.value }))} placeholder="Ej: 800" />
                  </div>
                  {!isSelfEditorEdit && (
                    <div className="form-group">
                      <label>{editProjectForm.payment_type === 'hourly' ? 'Tarifa editor ($/h)' : 'Pago al editor ($)'}</label>
                      <input className="input" type="number" min="0" value={editProjectForm.payment_amount} disabled={editorAmountLocked}
                        title={editorAmountLocked ? 'Ya se le pagó al editor con este monto — desmarcá "Pagado" en Pagos para poder corregirlo' : undefined}
                        onChange={e => setEditProjectForm(p => ({ ...p, payment_amount: e.target.value }))} placeholder="Ej: 500" />
                    </div>
                  )}
                  {editProjectForm.payment_type === 'hourly' && (
                    <div className="form-group">
                      <label>Horas estimadas</label>
                      <input className="input" type="number" min="0" value={editProjectForm.payment_hours} disabled={clientAmountLocked || editorAmountLocked}
                        title={(clientAmountLocked || editorAmountLocked) ? 'Ya se congeló un monto con estas horas — desmarcá el pago correspondiente para poder corregirlas' : undefined}
                        onChange={e => setEditProjectForm(p => ({ ...p, payment_hours: e.target.value }))} placeholder="Ej: 20" />
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

      {showCompleteConfirm && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowCompleteConfirm(false)} title="Cerrar">✕</button>
            <h2>¿Marcar como saldado?</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              Vas a marcar este proyecto como pagado al editor y cobrado al cliente — va a pasar a "Saldados" en Pagos.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowCompleteConfirm(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={async () => { setShowCompleteConfirm(false); const taskIdsToReassign = await reassignOldEditorTasks(); if (taskIdsToReassign === null) return; doSaveProject(taskIdsToReassign); }}>Sí, marcar como saldado</button>
            </div>
          </div>
        </div>
      )}

      {reassignReview && (
        <div className="modal-overlay">
          <div className="modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => finishReassignReview(null)} title="Cerrar">✕</button>
            <h2>Reasignar tareas</h2>
            <p style={{ fontSize: 12, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
              Tarea {reassignReview.index + 1} de {reassignReview.tasks.length}
            </p>
            <p style={{ fontSize: 14, color: 'var(--text)', lineHeight: 1.5, margin: '0 0 20px' }}>
              "<strong>{reassignReview.tasks[reassignReview.index].title}</strong>" está asignada a {reassignReview.oldName}. ¿Reasignarla a {reassignReview.newName}?
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => reassignCurrentAndAdvance(false)}>No</button>
                <button className="btn btn-primary" style={{ flex: 1 }} onClick={() => reassignCurrentAndAdvance(true)}>Sí, reasignar</button>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={reassignAllRemaining}>
                Reasignar todas las restantes ({reassignReview.tasks.length - reassignReview.index})
              </button>
            </div>
          </div>
        </div>
      )}

      {editingClient && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setEditingClient(null)} title="Cerrar">✕</button>
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
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setShowChangePassword(false)} title="Cerrar">✕</button>
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

      {toasts.length > 0 && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 1000, display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 340 }}>
          {toasts.map(t => (
            <div key={t.id} onClick={() => openToast(t)}
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 10, padding: '12px 14px', cursor: 'pointer', boxShadow: '0 8px 24px rgba(0,0,0,0.35)' }}>
              <div style={{ width: 30, height: 30, borderRadius: '50%', background: t.actor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: '#fff', flexShrink: 0 }}>
                {t.actor_name?.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.4 }}>{notificationLabel(t)}</div>
                {t.preview && <div style={{ fontSize: 11, color: 'var(--text2)', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>"{renderMentions(t.preview)}"</div>}
              </div>
              <button onClick={e => { e.stopPropagation(); dismissToast(t.id); }} title="Cerrar"
                style={{ background: 'transparent', border: 'none', color: 'var(--text3)', fontSize: 14, cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Botones editar/borrar de una fila de proyecto en el sidebar — solo visibles al pasar el mouse
// por la fila (clase .sidebar-row en el padre, ver index.css). Usado en las dos listas de
// proyectos (agrupados por cliente y sin cliente), antes duplicado en cada una.
function ProjectRowActions({ fontSize, padding, onEdit, onDelete, onDuplicate }) {
  return (
    <div style={{ display: 'flex', gap: 0 }}>
      {/* Solo las filas de proyecto pasan onDuplicate — no tiene sentido "duplicar" un cliente. */}
      {onDuplicate && <button className="reveal-btn edit" title="Duplicar proyecto" onClick={onDuplicate} style={{ fontSize, padding }}>⧉</button>}
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
        {admin && <span style={{ fontSize: 9, background: 'rgba(240,168,58,0.15)', color: 'var(--yellow)', padding: '1px 5px', borderRadius: 4, fontWeight: 700 }}>ADMIN</span>}
        {badge > 0 && <span className="badge badge-count" style={{ background: badgeRed ? 'var(--red)' : 'var(--accent)', fontSize: 10, padding: '1px 6px', minWidth: 18, textAlign: 'center' }}>{badge}</span>}
      </div>
    </Link>
  );
}
