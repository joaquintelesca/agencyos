import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useUndo } from '../context/UndoContext';
import { useAlert } from '../context/AlertContext';
import VideoReview from '../components/VideoReview';
import ActivityTimeline from '../components/ActivityTimeline';
import MentionInput, { renderMentions } from '../components/MentionInput';
import { initials } from '../utils/format';
import Icon from '../components/Icon';
import useNarrowViewport from '../hooks/useNarrowViewport';
import useModalA11y from '../hooks/useModalA11y';

const STATUSES = [
  { key: 'todo', label: 'Por hacer', color: 'var(--text2)', description: 'Todavía no se empezó.' },
  { key: 'in_progress', label: 'En progreso', color: 'var(--blue)', description: 'El editor la está trabajando.' },
  { key: 'review', label: 'En revisión', color: 'var(--yellow)', description: 'El editor subió una nueva versión, pendiente de feedback del admin.' },
  { key: 'feedback', label: 'Aplicar feedback', color: 'var(--red)', description: 'Hay comentarios del admin sin aplicar en el video.', note: '↻ Al aplicarlos, el editor debe volver a moverla a "En revisión".' },
  { key: 'done', label: 'Listo', color: 'var(--green)', description: 'Aprobado, sin cambios pendientes.' },
];
const PRIORITIES = ['low', 'medium', 'high'];

export default function Project() {
  const { id } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { api, user, socket } = useAuth();
  const { scheduleDelete } = useUndo();
  const { alert } = useAlert();
  const isNarrowViewport = useNarrowViewport();
  const [project, setProject] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  // Deep link desde una notificación de chat (?message=<id>): el id que hay que buscar y scrollear
  // apenas cargue, y el que hay que "flashear" un instante para que no quede perdido entre otros
  // mensajes. Se consumen apenas se resuelven (encontrado o no) para no bloquear el auto-scroll al
  // final normal en mensajes nuevos que lleguen después.
  const [pendingHighlight, setPendingHighlight] = useState(searchParams.get('message'));
  const [flashMessageId, setFlashMessageId] = useState(null);
  const [tab, setTab] = useState(searchParams.get('tab') || 'kanban');
  const [newMsg, setNewMsg] = useState('');
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [taskForm, setTaskForm] = useState({ title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '', due_date: '' });
  const [dragTask, setDragTask] = useState(null);
  const [reviewReminderTask, setReviewReminderTask] = useState(null);
  const [showPriceModal, setShowPriceModal] = useState(false);
  const [confirmComplete, setConfirmComplete] = useState(false);
  const [priceForm, setPriceForm] = useState({ payment_type: 'fixed', payment_amount: '', payment_rate: '', payment_hours: '', client_amount: '', client_rate: '', payment_editor_id: '', upwork_status: 'No', upwork_fee_pct: '', client_paid: 'unpaid' });
  const [uploadForTaskId, setUploadForTaskId] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [members, setMembers] = useState(null);
  const [showMembers, setShowMembers] = useState(false);
  const [membersError, setMembersError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [savingTask, setSavingTask] = useState(false);
  const msgEndRef = useRef(null);
  const msgContainerRef = useRef(null);

  useEffect(() => {
    setProject(null);
    setNotFound(false);
    setTasks([]);
    setMessages([]);
    setMembers(null);
    setMembersError('');
    setLoadError('');
    setPendingHighlight(searchParams.get('message'));
    // `cancelado` evita que la respuesta de un proyecto anterior pise la del actual: clickeando
    // A y después B con conexión lenta, la de A podía llegar última y mostrar los datos de A
    // en la URL de B. Los .catch faltantes dejaban el kanban vacío, como si el proyecto no
    // tuviera tareas, cuando en realidad la request había fallado.
    let cancelado = false;
    api(`/api/projects/${id}`).then(p => { if (!cancelado) setProject(p); }).catch(e => {
      console.error(e);
      if (!cancelado) setNotFound(true);
    });
    api(`/api/projects/${id}/tasks`)
      .then(t => { if (!cancelado) setTasks(t); })
      .catch(e => { console.error(e); if (!cancelado) setLoadError('No se pudieron cargar las tareas de este proyecto.'); });
    api(`/api/projects/${id}/messages`)
      .then(msgs => { if (!cancelado) { setMessages(msgs); setHasMore(msgs.length >= 50); } })
      .catch(console.error);
    api('/api/users').then(u => { if (!cancelado) setUsers(u); }).catch(console.error);
    return () => { cancelado = true; };
  }, [id]);

  // Quién tiene acceso a este proyecto (project_members) es un cálculo implícito del lado del
  // servidor — se le agrega gente automáticamente al asignarle una tarea o ponerla de editora, y
  // se la saca sola cuando ya no le queda ningún motivo para seguir ahí. Sin esta lista visible,
  // nadie puede saber quién ve este proyecto en un momento dado sin ir a revisar caso por caso.
  const loadMembers = useCallback(async () => {
    if (members) return;
    try {
      const data = await api(`/api/projects/${id}/members`);
      // Los admins tienen acceso a TODOS los proyectos siempre, no solo a los que figuran en
      // project_members (esa tabla es para editores) — si no se agregan acá a mano, un admin que
      // no creó el proyecto ni es su editor asignado quedaría afuera de esta lista aunque sí tenga
      // acceso real.
      const memberIds = new Set(data.map(m => m.id));
      const missingAdmins = users.filter(u => u.role === 'admin' && !memberIds.has(u.id))
        .map(u => ({ id: u.id, name: u.name, avatar_color: u.avatar_color, role: 'admin' }));
      setMembers([...data, ...missingAdmins]);
    } catch (e) { console.error(e); setMembersError('No se pudo cargar quién tiene acceso.'); }
  }, [id, members, users]);

  const openMembers = async () => { setShowMembers(true); await loadMembers(); };

  // Por usuario, no global — cada uno decide su propio volumen de avisos de este proyecto sin
  // afectar al resto del equipo. Las @menciones siguen llegando igual (ver createNotificationInner).
  const toggleMute = async () => {
    try {
      const { muted } = await api(`/api/projects/${id}/mute`, { method: project.muted ? 'DELETE' : 'POST' });
      setProject(prev => ({ ...prev, muted }));
    } catch (e) { console.error(e); }
  };

  // Las @menciones del chat necesitan la lista de miembros disponible apenas se entra a la
  // pestaña — antes solo se cargaba al abrir el panel "Acceso" a mano.
  useEffect(() => { if (tab === 'chat') loadMembers(); }, [tab, loadMembers]);

  // Deep link desde una notificación (?tab=videos): si ya estamos en este proyecto, React Router
  // no remonta el componente al cambiar solo el query param, así que hay que resincronizar el tab.
  // Lo mismo para ?message=: si ya estábamos en el chat de este mismo proyecto y llega otra
  // notificación de otro mensaje, el efecto de [id] de más arriba no vuelve a correr (el id no
  // cambió), así que hace falta resincronizar acá también.
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== tab) setTab(t);
    const m = searchParams.get('message');
    if (m) setPendingHighlight(m);
  }, [searchParams]); // eslint-disable-line

  // Scroll-to-message pendiente de una notificación: se resuelve apenas el mensaje buscado
  // aparezca en la página ya cargada. Si no está (una notificación vieja de un mensaje que ya
  // quedó varias páginas atrás), se desiste sin paginar hacia atrás a ciegas — el chat igual se
  // abrió, solo no hace el scroll puntual.
  useEffect(() => {
    if (!pendingHighlight || messages.length === 0) return;
    const el = document.getElementById(`msg-${pendingHighlight}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashMessageId(pendingHighlight);
      const t = setTimeout(() => setFlashMessageId(null), 2000);
      setPendingHighlight(null);
      return () => clearTimeout(t);
    }
    setPendingHighlight(null);
  }, [messages, pendingHighlight]);

  useEffect(() => {
    // Si hay un scroll-to-message pendiente, no lo tapemos yendo directo al final.
    if (pendingHighlight) return;
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingHighlight]);

  useEffect(() => {
    if (!socket) return;
    const onTask = (t) => {
      if (t.project_id !== id) return;
      setTasks(prev => {
        const exists = prev.find(x => x.id === t.id);
        return exists ? prev.map(x => x.id === t.id ? t : x) : [...prev, t];
      });
    };
    const onTaskDel = ({ id: tid }) => setTasks(prev => prev.filter(t => t.id !== tid));
    const onMsg = (m) => { if (m.project_id === id && m.type === 'project') setMessages(prev => [...prev, m]); };
    // Al reconectar, el socket es el mismo objeto pero el server le asigna un socket.id nuevo:
    // las rooms del lado del server no sobreviven, hay que volver a unirse. Aprovechamos para
    // resincronizar tareas y mensajes por si algo se perdió mientras estuvo desconectado.
    const onReconnect = () => {
      socket.emit('project:join', id);
      api(`/api/projects/${id}/tasks`).then(setTasks).catch(console.error);
      api(`/api/projects/${id}/messages`).then(msgs => { setMessages(msgs); setHasMore(msgs.length >= 50); }).catch(console.error);
    };
    socket.emit('project:join', id);
    socket.on('connect', onReconnect);
    socket.on('task:created', onTask);
    socket.on('task:updated', onTask);
    socket.on('task:deleted', onTaskDel);
    socket.on('message:new', onMsg);
    return () => {
      socket.emit('project:leave', id);
      socket.off('connect', onReconnect); socket.off('task:created', onTask); socket.off('task:updated', onTask); socket.off('task:deleted', onTaskDel); socket.off('message:new', onMsg);
    };
  }, [socket, id]);

  const loadOlderMessages = useCallback(async () => {
    if (loadingOlder || !hasMore || messages.length === 0) return;
    setLoadingOlder(true);
    try {
      const oldest = messages[0];
      const older = await api(`/api/projects/${id}/messages?before=${oldest.id}`);
      if (older.length < 50) setHasMore(false);
      if (older.length > 0) {
        const container = msgContainerRef.current;
        const prevHeight = container?.scrollHeight || 0;
        setMessages(prev => [...older, ...prev]);
        requestAnimationFrame(() => {
          if (container) container.scrollTop = container.scrollHeight - prevHeight;
        });
      }
    } catch (e) {
      console.error('Error cargando mensajes anteriores:', e);
    } finally {
      setLoadingOlder(false);
    }
  }, [messages, loadingOlder, hasMore, api, id]);

  const openCreateTask = (status = 'todo') => {
    setEditingTask(null);
    // Si el proyecto ya tiene un editor asignado, lo más común es que la tarea nueva sea para esa
    // misma persona — se precarga como default, pero se puede cambiar antes de crear.
    setTaskForm({ title: '', description: '', status, priority: 'medium', assigned_to: project.payment_editor_id || '', due_date: '' });
    setShowTaskModal(true);
  };

  const openEditTask = (task) => {
    setEditingTask(task);
    setTaskForm({ title: task.title, description: task.description || '', status: task.status, priority: task.priority, assigned_to: task.assigned_to || '', due_date: task.due_date || '' });
    setShowTaskModal(true);
  };

  const saveTask = async () => {
    if (!taskForm.title.trim() || savingTask) return;
    // Sin el guard, un doble clic creaba dos tareas iguales; sin el catch, un error dejaba el
    // modal abierto sin decir nada y parecía que el botón no hacía nada.
    setSavingTask(true);
    try {
      if (editingTask) {
        await api(`/api/tasks/${editingTask.id}`, { method: 'PUT', body: taskForm });
      } else {
        await api(`/api/projects/${id}/tasks`, { method: 'POST', body: taskForm });
      }
      setShowTaskModal(false);
    } catch (e) {
      console.error(e);
      await alert('No se pudo guardar la tarea: ' + e.message);
    } finally {
      setSavingTask(false);
    }
  };

  const deleteTask = (taskId) => {
    const task = tasks.find(t => t.id === taskId);
    if (!task) return;
    setTasks(prev => prev.filter(t => t.id !== taskId));
    scheduleDelete(`Tarea "${task.title}" eliminada`, {
      onCommit: () => api(`/api/tasks/${taskId}`, { method: 'DELETE' }),
      onUndo: () => setTasks(prev => [...prev, task])
    });
  };

  const sendMessage = (e) => {
    e.preventDefault();
    if (!newMsg.trim() || !socket) return;
    const content = newMsg;
    setNewMsg('');
    // .timeout() + callback: antes era fire-and-forget (el input se vaciaba sin esperar nada).
    // Si el socket estaba desconectado en ese instante, el mensaje se perdía en silencio.
    socket.timeout(8000).emit('message:send', {
      project_id: id, content, type: 'project',
      sender_id: user.id, sender_name: user.name, sender_color: user.avatar_color
    }, async (err, response) => {
      if (err || response?.error) {
        const reason = err ? 'sin respuesta del servidor' : response.error;
        // Si mientras tanto ya empezaste a escribir otra cosa, no la pisamos — pero tampoco
        // podemos perder el texto que falló en silencio, así que va en el aviso. El alert() se
        // dispara acá afuera (no dentro del updater de setNewMsg): un efecto secundario dentro
        // de un updater se duplica si React lo vuelve a invocar (ej. StrictMode).
        let hadDraft = false;
        setNewMsg(prev => { hadDraft = !!prev; return prev || content; });
        await alert(hadDraft
          ? `No se pudo enviar el mensaje (${reason}). Tu mensaje sin enviar era: "${content}"`
          : `No se pudo enviar el mensaje (${reason}). Reintentá.`);
      }
    });
  };

  // Salta directo a la última versión del video enlazado a la tarea, sin tener que buscarlo
  // a mano en la pestaña Videos — reusa el mismo mecanismo de deep link que usan las notificaciones.
  const openTaskVideo = (videoId) => {
    setSearchParams({ tab: 'videos', video: videoId });
  };

  // "Terminado" es la única señal que decide si el proyecto pasa a Pagos — no se infiere de las
  // tareas porque un proyecto puede seguir sumando tareas nuevas después de parecer completo.
  // Si todavía le falta precio o editor, no tiene sentido dejarlo pasar a Pagos así: se piden
  // acá mismo antes de completar, en vez de mandar al admin a buscarlos en "Editar proyecto".
  const toggleProjectStatus = async () => {
    // Si el editor asignado sos vos mismo, no hay "pago a editor" real — el precio que importa
    // ahí es el cobro al cliente, no payment_amount (que se guarda en 0 a propósito).
    const isSelfEditor = project.payment_editor_id === user.id;
    const missingPrice = isSelfEditor ? !(Number(project.client_amount) > 0) : !(Number(project.payment_amount) > 0);
    const missingEditor = !project.payment_editor_id;
    if (project.status !== 'completed' && (missingPrice || missingEditor)) {
      setPriceForm({
        payment_type: project.payment_type || 'fixed', payment_amount: '', payment_rate: '', payment_hours: project.payment_hours || '',
        client_amount: '', client_rate: '', payment_editor_id: project.payment_editor_id || '',
        // Preservar lo que ya estaba cargado (si el proyecto ya tenía Upwork activo o un anticipo
        // cobrado antes de que le faltara editor/precio) — antes savePriceAndComplete mandaba
        // upwork_status del proyecto pero nunca upwork_fee_pct, así que completar acá reseteaba en
        // silencio la comisión guardada al default de 15%.
        upwork_status: (project.upwork_status === 'Pendiente de carga' || project.upwork_status === 'Cargado') ? project.upwork_status : 'No',
        upwork_fee_pct: project.upwork_fee_pct ?? '',
        client_paid: project.client_paid === 'cobrado' ? 'cobrado' : 'unpaid'
      });
      setShowPriceModal(true);
      return;
    }
    // Reabrir se hace directo (deshacer no es riesgoso), pero completar con editor+precio ya
    // cargados era un solo click sin ninguna confirmación — bastaba un click de más para que el
    // proyecto pasara a Pagos sin querer. Acá no, se pide confirmar antes.
    if (project.status !== 'completed') {
      setConfirmComplete(true);
      return;
    }
    try {
      const updated = await api(`/api/projects/${id}/status`, { method: 'PATCH', body: { status: 'active' } });
      setProject(updated);
    } catch (e) {
      await alert('Error al actualizar el estado del proyecto: ' + e.message);
    }
  };

  const confirmCompleteProject = async () => {
    try {
      const updated = await api(`/api/projects/${id}/status`, { method: 'PATCH', body: { status: 'completed' } });
      setProject(updated);
    } catch (e) {
      await alert('Error al actualizar el estado del proyecto: ' + e.message);
    } finally {
      setConfirmComplete(false);
    }
  };

  const isSelfEditorPrice = priceForm.payment_editor_id === user.id;
  const priceFormAmount = () => priceForm.payment_type === 'fixed' ? priceForm.payment_amount : priceForm.payment_rate;
  const priceFormClientAmount = () => priceForm.payment_type === 'fixed' ? priceForm.client_amount : priceForm.client_rate;
  const priceFormValid = () => priceForm.payment_editor_id && (isSelfEditorPrice ? priceFormClientAmount() : priceFormAmount());
  const estimatedEditorTotal = () => {
    if (priceForm.payment_type === 'hourly') return (parseFloat(priceForm.payment_rate) || 0) * (parseFloat(priceForm.payment_hours) || 0);
    return parseFloat(priceForm.payment_amount) || 0;
  };
  const estimatedClientTotal = () => {
    if (priceForm.payment_type === 'hourly') return (parseFloat(priceForm.client_rate) || 0) * (parseFloat(priceForm.payment_hours) || 0);
    return parseFloat(priceForm.client_amount) || 0;
  };
  // Cuando se cobra por Upwork, lo que realmente llega a la cuenta es el cobro al cliente menos
  // la comisión de la plataforma — el "Cobro cliente" que carga el admin es el bruto.
  const estimatedClientNet = () => {
    const gross = estimatedClientTotal();
    if (priceForm.upwork_status === 'No') return gross;
    return gross * (1 - (parseFloat(priceForm.upwork_fee_pct) || 0) / 100);
  };

  const savePriceAndComplete = async () => {
    if (!priceFormValid()) return;
    try {
      // Guarda el precio/editor/Upwork primero (sin tocar el status todavía) y recién después pasa
      // por PATCH /status para completar — ese endpoint es el único que valida precio+editor Y
      // marca ever_completed=true (necesario para que Pagos no pierda el historial si el proyecto
      // se reabre más adelante). Completar directo con un PUT status:'completed' se saltaba esa
      // marca.
      let updated = await api(`/api/projects/${id}`, {
        method: 'PUT',
        body: {
          name: project.name, description: project.description, color: project.color,
          client_id: project.client_id, deadline: project.deadline, material_link: project.material_link,
          payment_editor_id: priceForm.payment_editor_id,
          payment_type: priceForm.payment_type,
          payment_amount: isSelfEditorPrice ? 0 : priceFormAmount(),
          payment_hours: priceForm.payment_hours,
          payment_status: project.payment_status,
          upwork_status: priceForm.upwork_status, upwork_fee_pct: priceForm.upwork_fee_pct,
          client_amount: priceForm.payment_type === 'fixed' ? priceForm.client_amount : priceForm.client_rate,
          status: project.status
        }
      });
      updated = await api(`/api/projects/${id}/status`, { method: 'PATCH', body: { status: 'completed' } });
      // client_paid necesita pasar por el endpoint de Pagos para "congelar" el monto real en ese
      // momento (ver PATCH /api/payments/:id en el servidor).
      if (priceForm.client_paid === 'cobrado' && project.client_paid !== 'cobrado') {
        await api(`/api/payments/${id}`, { method: 'PATCH', body: { client_paid: 'cobrado' } });
        updated = await api(`/api/projects/${id}`);
      }
      setProject(updated);
      setShowPriceModal(false);
    } catch (e) {
      await alert('Error al guardar el precio: ' + e.message);
    }
  };

  const moveTaskToStatus = async (task, status) => {
    if (!task || task.status === status) return;
    try {
      // Solo se manda el campo que cambió: mandar la tarea entera (snapshot capturado al
      // agarrarla) podía pisar una edición concurrente de otra persona con datos viejos.
      await api(`/api/tasks/${task.id}`, { method: 'PUT', body: { status } });
      if (status === 'review' && task.status !== 'review') {
        setReviewReminderTask({ ...task, status });
      }
    } catch (e) {
      await alert('Error al mover la tarea: ' + e.message);
    }
  };
  const onDragStart = (task) => setDragTask(task);
  const onDrop = (status) => {
    const task = dragTask;
    setDragTask(null);
    moveTaskToStatus(task, status);
  };

  const formatTime = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  // Los 3 hooks de abajo tienen que llamarse ANTES de los early return de notFound/!project —
  // si no, la primera carga (con !project todavía true) los saltea, y en cuanto project llega
  // React tira "Rendered more hooks than during the previous render" (bug real, visto en Pagos
  // con el mismo patrón: un hook agregado después de un early return existente).
  const taskModalRef = useModalA11y(showTaskModal, () => setShowTaskModal(false));
  const reviewReminderModalRef = useModalA11y(!!reviewReminderTask, () => setReviewReminderTask(null));
  const priceModalRef = useModalA11y(showPriceModal, () => setShowPriceModal(false));
  const confirmCompleteModalRef = useModalA11y(confirmComplete, () => setConfirmComplete(false));

  if (notFound) return (
    <div className="empty" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div className="empty-icon">🔍</div>
      <p>Proyecto no encontrado</p>
      <Link to="/" className="btn btn-primary" style={{ marginTop: 12 }}>Volver al dashboard</Link>
    </div>
  );

  if (!project) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  // Mismo chequeo que hace toggleProjectStatus antes de decidir si completar de una o pedir precio
  // primero — se repite acá solo para poder avisar en el botón ANTES de clickearlo, en vez de que
  // la sorpresa (el modal de precio) aparezca recién al hacer click sin ningún indicio previo.
  const needsPriceToComplete = project.status !== 'completed' && (
    (project.payment_editor_id === user.id ? !(Number(project.client_amount) > 0) : !(Number(project.payment_amount) > 0))
    || !project.payment_editor_id
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header — en angosto no entra todo en una sola fila (título+badges+botones+tabs), así
          que se deja envolver a varias líneas en vez de recortarse fuera de la vista. */}
      <div style={{
        padding: isNarrowViewport ? '10px 16px' : '0 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center',
        justifyContent: 'space-between', flexShrink: 0,
        ...(isNarrowViewport ? { flexWrap: 'wrap', rowGap: 8 } : { height: 56 })
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: isNarrowViewport ? 'wrap' : 'nowrap', rowGap: 6 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: project.color }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 'var(--fs-lg)' }}>{project.name}</h2>
          {project.client_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 7, height: 7, borderRadius: '50%', background: project.client_color || 'var(--text3)' }} />
              <span style={{ fontSize: 12, color: 'var(--text3)' }}>{project.client_name}</span>
            </div>
          )}
          <span className="badge" style={{ fontSize: 12, fontWeight: 400, color: 'var(--text3)', background: 'var(--bg3)' }}>{tasks.length} tareas</span>
          <button onClick={toggleMute} title={project.muted ? 'Reactivar notificaciones de este proyecto' : 'Silenciar notificaciones de este proyecto (las @menciones igual llegan)'}
            aria-label={project.muted ? 'Reactivar notificaciones' : 'Silenciar notificaciones'}
            style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: project.muted ? 'var(--yellow)' : 'var(--text3)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font)' }}>
            {project.muted ? '🔕 Silenciado' : '🔔'}
          </button>
          <div style={{ position: 'relative' }}>
            <button onClick={() => showMembers ? setShowMembers(false) : openMembers()}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text3)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: 'var(--font)' }}>
              👥 Acceso
            </button>
            {showMembers && (
              <>
                <div onClick={() => setShowMembers(false)} style={{ position: 'fixed', inset: 0, zIndex: 10 }} />
                <div className="panel" style={{
                  position: 'absolute', top: 'calc(100% + 6px)', left: 0, minWidth: 220, zIndex: 11,
                  borderRadius: 10,
                  boxShadow: '0 8px 24px rgba(0,0,0,0.35)', padding: 8
                }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '2px 6px 8px' }}>Quién tiene acceso</div>
                  {membersError && <div style={{ fontSize: 12, color: 'var(--red)', padding: '4px 6px' }}>{membersError}</div>}
                  {!membersError && !members && <div style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 6px' }}>Cargando...</div>}
                  {members && members.length === 0 && <div style={{ fontSize: 12, color: 'var(--text3)', padding: '4px 6px' }}>Nadie tiene acceso todavía</div>}
                  {members && members.map(m => (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px' }}>
                      <div className="avatar" style={{ width: 22, height: 22, background: m.avatar_color || 'var(--accent)', fontSize: 9, fontWeight: 700 }}>{initials(m.name)}</div>
                      <span style={{ fontSize: 13, color: 'var(--text)', flex: 1 }}>{m.name}</span>
                      <span style={{ fontSize: 10, color: 'var(--text3)', textTransform: 'uppercase' }}>{m.role === 'admin' ? 'admin' : m.member_role === 'owner' ? 'creador' : 'editor'}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
          {project.material_link && (
            <a href={/^https?:\/\//i.test(project.material_link) ? project.material_link : `https://${project.material_link}`}
              target="_blank" rel="noopener noreferrer" title={project.material_link}
              style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--accent2)', background: 'var(--accent-glow)', padding: '2px 8px', borderRadius: 8, textDecoration: 'none' }}>
              🔗 Material
            </a>
          )}
          {project.payment_editor_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div className="avatar" style={{ width: 20, height: 20, background: project.payment_editor_color || 'var(--accent)', fontSize: 8, fontWeight: 700 }}>{initials(project.payment_editor_name)}</div>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{project.payment_editor_name}</span>
            </div>
          )}
          {user.role === 'admin' && (
            <button onClick={toggleProjectStatus}
              title={project.status === 'completed' ? 'Volver a activo' : needsPriceToComplete ? 'Todavía falta cargar el editor y/o el precio — se te va a pedir antes de completar' : 'Marcalo cuando no vayas a agregar más tareas — recién ahí pasa a Pagos'}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: project.status === 'completed' ? '4px 10px' : '7px 16px', borderRadius: 8,
                border: 'none',
                background: project.status === 'completed' ? 'var(--bg3)' : needsPriceToComplete ? 'var(--yellow)' : 'var(--green)',
                color: project.status === 'completed' ? 'var(--text2)' : needsPriceToComplete ? '#1a1a1a' : '#fff',
                fontSize: project.status === 'completed' ? 12 : 13, fontWeight: 700, cursor: 'pointer', fontFamily: 'var(--font)',
                boxShadow: project.status === 'completed' ? 'none' : needsPriceToComplete ? '0 1px 6px rgba(240,168,58,0.4)' : '0 1px 6px rgba(34,201,122,0.4)'
              }}>
              {project.status === 'completed' ? '↺ Reabrir proyecto' : needsPriceToComplete ? '⚠ Falta precio para terminar' : '✓ Marcar como terminado'}
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['kanban', 'chat', 'videos', 'activity'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '6px 14px', borderRadius: 8, border: 'none', fontFamily: 'var(--font)', fontSize: 13,
              cursor: 'pointer', fontWeight: tab === t ? 600 : 400,
              background: tab === t ? 'var(--bg3)' : 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--text2)',
            }}>
              {t === 'kanban' ? '📋 Tareas' : t === 'chat' ? '💬 Chat' : t === 'videos' ? '🎬 Videos' : '🕓 Actividad'}
            </button>
          ))}
        </div>
      </div>

      {/* Kanban */}
      {tab === 'kanban' && loadError && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, background: 'rgba(240,92,92,0.08)', border: '1px solid rgba(240,92,92,0.3)', borderRadius: 8, padding: '10px 14px', margin: '14px 20px 0', fontSize: 13, color: 'var(--red)' }}>
          <span>⚠️ {loadError}</span>
          <button className="btn-retry" onClick={() => window.location.reload()}>Reintentar</button>
        </div>
      )}
      {tab === 'kanban' && (
        <div style={{ display: 'flex', gap: 12, padding: 20, overflowX: 'auto', flex: 1 }}>
          {STATUSES.map(col => (
            <div key={col.key} style={{ width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
              onDragOver={e => e.preventDefault()} onDrop={() => onDrop(col.key)}>
              <div style={{ marginBottom: 10, padding: '0 4px' }}>
                {col.description && (
                  <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: col.note ? 1 : 4, lineHeight: 1.3 }}>{col.description}</div>
                )}
                {col.note && (
                  <div style={{ fontSize: 10.5, color: 'var(--text3)', opacity: 0.8, fontStyle: 'italic', marginBottom: 4, lineHeight: 1.3 }}>{col.note}</div>
                )}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: col.color }}>{col.label}</span>
                    <span className="badge" style={{ fontWeight: 400, background: 'var(--bg3)', color: 'var(--text3)', padding: '1px 7px' }}>
                      {tasks.filter(t => t.status === col.key).length}
                    </span>
                  </div>
                  {user.role === 'admin' && <button className="icon-btn" onClick={() => openCreateTask(col.key)} title={`Agregar tarea a ${col.label}`} aria-label={`Agregar tarea a ${col.label}`} style={{ color: 'var(--text3)', display: 'flex' }}><Icon.plus /></button>}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                {tasks.filter(t => t.status === col.key).map(task => (
                  <TaskCard key={task.id} task={task}
                    onEdit={user.role === 'admin' ? () => openEditTask(task) : null}
                    onDelete={user.role === 'admin' ? () => deleteTask(task.id) : null}
                    onDragStart={() => onDragStart(task)} initials={initials}
                    onOpenVideo={openTaskVideo}
                    canDrag={user.role === 'admin' || task.assigned_to === user.id}
                    onMoveToReview={(user.role === 'admin' || task.assigned_to === user.id) ? () => moveTaskToStatus(task, 'review') : null} />
                ))}
              </div>
              {user.role === 'admin' && (
                <button onClick={() => openCreateTask(col.key)} style={{
                  marginTop: 8, padding: '8px', borderRadius: 8, border: '1px dashed var(--border)',
                  background: 'transparent', color: 'var(--text3)', fontSize: 12, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'center'
                }}>
                  <Icon.plus /> Agregar tarea
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Chat */}
      {tab === 'chat' && (
        <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
          <div
            ref={msgContainerRef}
            onScroll={e => { if (e.target.scrollTop < 80 && hasMore && !loadingOlder) loadOlderMessages(); }}
            style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 4 }}
          >
            {hasMore && messages.length > 0 && (
              <div style={{ textAlign: 'center', padding: '8px 0' }}>
                <button
                  onClick={loadOlderMessages}
                  disabled={loadingOlder}
                  style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: 12 }}
                >
                  {loadingOlder ? 'Cargando...' : 'Cargar mensajes anteriores'}
                </button>
              </div>
            )}
            {messages.length === 0 && (
              <div className="empty"><div className="empty-icon">💬</div><p>Sin mensajes todavía</p><p>¡Iniciá la conversación!</p></div>
            )}
            {messages.map((m, i) => {
              const isMine = m.sender_id === user.id;
              const showAvatar = i === 0 || messages[i-1].sender_id !== m.sender_id;
              return (
                <div key={m.id} id={`msg-${m.id}`} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexDirection: isMine ? 'row-reverse' : 'row', marginTop: showAvatar ? 12 : 2 }}>
                  {!isMine && (
                    <div style={{ width: 28, flexShrink: 0 }}>
                      {showAvatar && <div className="avatar" style={{ background: m.sender_color || 'var(--accent)', fontSize: 11 }}>{initials(m.sender_name)}</div>}
                    </div>
                  )}
                  <div style={{ maxWidth: '70%' }}>
                    {showAvatar && !isMine && <div style={{ fontSize: 11, color: 'var(--text2)', marginBottom: 3, marginLeft: 2 }}>{m.sender_name}</div>}
                    <div style={{
                      background: isMine ? 'var(--accent)' : 'var(--bg3)',
                      color: 'var(--text)', padding: '9px 13px', borderRadius: isMine ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                      fontSize: 14, lineHeight: 1.5,
                      boxShadow: flashMessageId === m.id ? '0 0 0 2px var(--accent)' : 'none',
                      transition: 'box-shadow 0.3s'
                    }}>{renderMentions(m.content)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3, textAlign: isMine ? 'right' : 'left' }}>{formatTime(m.created_at)}</div>
                  </div>
                </div>
              );
            })}
            <div ref={msgEndRef} />
          </div>
          <form onSubmit={sendMessage} style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
            <MentionInput as="input" className="input" value={newMsg} onChange={setNewMsg} members={members || []}
              placeholder={`Mensaje en ${project.name}... (@ para mencionar)`} style={{ flex: 1 }} />
            <button className="btn btn-primary" type="submit">Enviar</button>
          </form>
        </div>
      )}

      {/* Videos */}
      {tab === 'videos' && (
        <VideoReview
          projectId={id}
          tasks={tasks}
          uploadForTaskId={uploadForTaskId}
          onUploadForTaskHandled={() => setUploadForTaskId(null)}
          initialVideoId={searchParams.get('video')}
        />
      )}

      {tab === 'activity' && <ActivityTimeline projectId={id} />}

      {/* Task Modal */}
      {showTaskModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={taskModalRef} role="dialog" aria-modal="true" aria-labelledby="task-modal-title">
            <button className="modal-close" onClick={() => setShowTaskModal(false)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="task-modal-title">{editingTask ? 'Editar tarea' : 'Nueva tarea'}</h2>
            <div className="form-group">
              <label>Título</label>
              <input className="input" value={taskForm.title} onChange={e => setTaskForm(p => ({ ...p, title: e.target.value }))} placeholder="¿Qué hay que hacer?" autoFocus />
            </div>
            <div className="form-group">
              <label>Descripción</label>
              <textarea className="input" value={taskForm.description} onChange={e => setTaskForm(p => ({ ...p, description: e.target.value }))} placeholder="Detalles adicionales..." />
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Estado</label>
                <select className="input" value={taskForm.status} onChange={e => setTaskForm(p => ({ ...p, status: e.target.value }))}>
                  {STATUSES.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Prioridad</label>
                <select className="input" value={taskForm.priority} onChange={e => setTaskForm(p => ({ ...p, priority: e.target.value }))}>
                  {PRIORITIES.map(p => <option key={p} value={p}>{p === 'high' ? 'Alta' : p === 'medium' ? 'Media' : 'Baja'}</option>)}
                </select>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label>Asignar a</label>
                <select className="input" value={taskForm.assigned_to} onChange={e => setTaskForm(p => ({ ...p, assigned_to: e.target.value }))}>
                  <option value="">Sin asignar</option>
                  {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Fecha límite</label>
                <input className="input" type="date" value={taskForm.due_date} onChange={e => setTaskForm(p => ({ ...p, due_date: e.target.value }))} />
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              {editingTask && <button className="btn btn-danger" onClick={() => { deleteTask(editingTask.id); setShowTaskModal(false); }}>Eliminar</button>}
              <button className="btn btn-ghost" onClick={() => setShowTaskModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={saveTask} disabled={savingTask}>{savingTask ? 'Guardando...' : editingTask ? 'Guardar' : 'Crear'}</button>
            </div>
          </div>
        </div>
      )}

      {reviewReminderTask && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={reviewReminderModalRef} role="dialog" aria-modal="true" aria-labelledby="review-reminder-modal-title">
            <button className="modal-close" onClick={() => setReviewReminderTask(null)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="review-reminder-modal-title">Tarea en revisión</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              Moviste <strong>"{reviewReminderTask.title}"</strong> a revisión. ¿Querés subir la última versión del video para esta tarea?
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setReviewReminderTask(null)}>Ahora no</button>
              <button className="btn btn-primary" onClick={() => {
                setUploadForTaskId(reviewReminderTask.id);
                setTab('videos');
                setReviewReminderTask(null);
              }}>
                Ir a Videos
              </button>
            </div>
          </div>
        </div>
      )}

      {confirmComplete && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={confirmCompleteModalRef} role="dialog" aria-modal="true" aria-labelledby="confirm-complete-modal-title">
            <button className="modal-close" onClick={() => setConfirmComplete(false)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="confirm-complete-modal-title">¿Marcar como terminado?</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              El proyecto va a pasar a Pagos. Marcalo solo si no vas a agregar más tareas — si después seguís trabajándolo, "Reabrir proyecto" lo devuelve al Kanban.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setConfirmComplete(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={confirmCompleteProject}>Sí, marcar como terminado</button>
            </div>
          </div>
        </div>
      )}

      {showPriceModal && (
        <div className="modal-overlay">
          <div className="modal" onClick={e => e.stopPropagation()} ref={priceModalRef} role="dialog" aria-modal="true" aria-labelledby="price-modal-title">
            <button className="modal-close" onClick={() => setShowPriceModal(false)} title="Cerrar" aria-label="Cerrar">✕</button>
            <h2 id="price-modal-title">Faltan datos para terminar el proyecto</h2>
            <p style={{ color: 'var(--text2)', fontSize: 14, lineHeight: 1.5, margin: '12px 0' }}>
              Para marcarlo como terminado y que pase a Pagos, el proyecto necesita un editor asignado y un precio cargado.
            </p>
            <div className="form-group">
              <label>Editor asignado</label>
              <select className="input" value={priceForm.payment_editor_id} onChange={e => setPriceForm(p => ({ ...p, payment_editor_id: e.target.value }))}>
                <option value="">Seleccioná un editor</option>
                {users.map(u => (
                  <option key={u.id} value={u.id}>{u.name}{u.id === user.id ? ' (vos)' : ''}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Tipo de pago</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                {[['fixed', '💵 Precio fijo'], ['hourly', '⏱ Por horas']].map(([val, label]) => (
                  <button key={val} type="button" onClick={() => setPriceForm(p => ({ ...p, payment_type: val }))}
                    style={{ padding: '8px 12px', borderRadius: 8, border: `1px solid ${priceForm.payment_type === val ? 'var(--accent)' : 'var(--border)'}`, background: priceForm.payment_type === val ? 'var(--accent-glow)' : 'var(--bg3)', cursor: 'pointer', fontSize: 12, fontWeight: 500, color: priceForm.payment_type === val ? 'var(--accent2)' : 'var(--text2)', fontFamily: 'var(--font)' }}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" checked={priceForm.upwork_status !== 'No'}
                  onChange={e => setPriceForm(p => ({ ...p, upwork_status: e.target.checked ? 'Pendiente de carga' : 'No', upwork_fee_pct: e.target.checked ? (p.upwork_fee_pct || 15) : '' }))} />
                Se cobra al cliente por Upwork
              </label>
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>
                Solo afecta lo que se le cobra al cliente — el pago al editor nunca cambia por esto.
              </div>
              {priceForm.upwork_status !== 'No' && (
                <div style={{ marginTop: 8 }}>
                  <label>% comisión que descuenta Upwork</label>
                  <input className="input" type="number" min="0" max="100" value={priceForm.upwork_fee_pct}
                    onChange={e => setPriceForm(p => ({ ...p, upwork_fee_pct: e.target.value }))} placeholder="Ej: 15" />
                </div>
              )}
            </div>
            <div className="form-group">
              <label style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
                <input type="checkbox" checked={priceForm.client_paid === 'cobrado'}
                  onChange={e => setPriceForm(p => ({ ...p, client_paid: e.target.checked ? 'cobrado' : 'unpaid' }))} />
                El cliente ya pagó este proyecto
              </label>
            </div>
            {isSelfEditorPrice && (
              <div style={{ background: 'var(--bg3)', border: '1px dashed var(--border2)', borderRadius: 8, padding: '8px 12px', marginBottom: 14, fontSize: 12, color: 'var(--text2)' }}>
                Como el editor sos vos, no hay "pago a editor" — solo se registra lo que le cobrás al cliente.
              </div>
            )}
            {priceForm.payment_type === 'fixed' ? (
              <div className="form-row" style={isSelfEditorPrice ? { gridTemplateColumns: '1fr' } : undefined}>
                <div className="form-group">
                  <label>Cobro al cliente ($)</label>
                  <input className="input" type="number" min="0" autoFocus value={priceForm.client_amount}
                    onChange={e => setPriceForm(p => ({ ...p, client_amount: e.target.value }))} placeholder="Ej: 800" />
                </div>
                {!isSelfEditorPrice && (
                  <div className="form-group">
                    <label>Pago al editor ($)</label>
                    <input className="input" type="number" min="0" value={priceForm.payment_amount}
                      onChange={e => setPriceForm(p => ({ ...p, payment_amount: e.target.value }))} placeholder="Ej: 500" />
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="form-row" style={isSelfEditorPrice ? { gridTemplateColumns: '1fr' } : undefined}>
                  <div className="form-group">
                    <label>Tarifa cliente ($/h)</label>
                    <input className="input" type="number" min="0" autoFocus value={priceForm.client_rate}
                      onChange={e => setPriceForm(p => ({ ...p, client_rate: e.target.value }))} placeholder="Ej: 40" />
                  </div>
                  {!isSelfEditorPrice && (
                    <div className="form-group">
                      <label>Tarifa editor ($/h)</label>
                      <input className="input" type="number" min="0" value={priceForm.payment_rate}
                        onChange={e => setPriceForm(p => ({ ...p, payment_rate: e.target.value }))} placeholder="Ej: 25" />
                    </div>
                  )}
                </div>
                <div className="form-group">
                  <label>Horas estimadas</label>
                  <input className="input" type="number" min="0" value={priceForm.payment_hours}
                    onChange={e => setPriceForm(p => ({ ...p, payment_hours: e.target.value }))} placeholder="Ej: 20" />
                </div>
              </>
            )}
            {(isSelfEditorPrice ? estimatedClientTotal() > 0 : (estimatedEditorTotal() > 0 || estimatedClientTotal() > 0)) && (
              <div style={{ background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 14px', marginBottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {!isSelfEditorPrice && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--pink)' }}>Pago editor:</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--pink)' }}>${estimatedEditorTotal().toFixed(0)}</span>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: 'var(--lavender)' }}>Cobro cliente{priceForm.upwork_status !== 'No' ? ' (bruto)' : ''}:</span>
                  <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--lavender)' }}>${estimatedClientTotal().toFixed(0)}</span>
                </div>
                {priceForm.upwork_status !== 'No' && (
                  <>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--text3)' }}>Comisión Upwork ({priceForm.upwork_fee_pct || 0}%):</span>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text3)' }}>-${(estimatedClientTotal() - estimatedClientNet()).toFixed(0)}</span>
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: 'var(--lavender)' }}>Recibís (neto):</span>
                      <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--lavender)' }}>${estimatedClientNet().toFixed(0)}</span>
                    </div>
                  </>
                )}
                {!isSelfEditorPrice && estimatedClientNet() > estimatedEditorTotal() && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                    <span style={{ fontSize: 12, color: 'var(--green)' }}>Ganancia:</span>
                    <span style={{ fontSize: 16, fontWeight: 700, color: 'var(--green)' }}>${(estimatedClientNet() - estimatedEditorTotal()).toFixed(0)}</span>
                  </div>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-ghost" onClick={() => setShowPriceModal(false)}>Cancelar</button>
              <button className="btn btn-primary" onClick={savePriceAndComplete} disabled={!priceFormValid()}>Guardar y marcar como terminado</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function TaskCard({ task, onEdit, onDelete, onDragStart, onOpenVideo, initials, canDrag = true, onMoveToReview }) {
  const priorityColors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' };
  const priorityLabels = { high: 'Alta', medium: 'Media', low: 'Baja' };
  return (
    <div className="panel" draggable={canDrag} onDragStart={canDrag ? onDragStart : undefined} onClick={onEdit || undefined} style={{
      borderRadius: 10,
      padding: '12px 14px', cursor: canDrag || onEdit ? 'pointer' : 'default', transition: 'all 0.15s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', lineHeight: 1.45, marginBottom: task.description ? 4 : 10 }}>{task.title}</div>
      {/* El brief solo vivía en el modal de edición, que es admin-only (onEdit es null para un
          editor) — la persona que hace el trabajo no tenía forma de leerlo. Se corta a 3 líneas
          para no inflar la card; el texto completo sigue estando en el modal para quien puede
          editar. */}
      {task.description && (
        <div style={{
          fontSize: 12, color: 'var(--text3)', lineHeight: 1.4, marginBottom: 10,
          display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden'
        }}>
          {task.description}
        </div>
      )}
      {task.latest_video_id && (
        <button
          onClick={e => { e.stopPropagation(); onOpenVideo(task.latest_video_id); }}
          title="Ver el video de esta tarea"
          style={{ display: 'flex', alignItems: 'center', gap: 5, background: 'var(--bg3)', border: '1px solid var(--border)', borderRadius: 7, padding: '3px 8px', marginBottom: 10, color: 'var(--text2)', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font)' }}>
          🎬 Ver video
        </button>
      )}
      {task.status === 'feedback' && onMoveToReview && (
        <button
          onClick={e => { e.stopPropagation(); onMoveToReview(); }}
          title="Mueve la tarea a 'En revisión'"
          style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', justifyContent: 'center', background: 'var(--accent-glow)', border: '1px solid var(--accent)', borderRadius: 7, padding: '5px 8px', marginBottom: 10, color: 'var(--accent2)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'var(--font)' }}>
          ✓ Ya apliqué el feedback → revisión
        </button>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span className="badge" style={{ padding: '2px 7px', background: `${priorityColors[task.priority]}18`, color: priorityColors[task.priority] }}>
          {priorityLabels[task.priority]}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {task.due_date && <span style={{ fontSize: 10, color: 'var(--text3)' }}>📅 {new Date(task.due_date + 'T00:00:00').toLocaleDateString('es', { day: 'numeric', month: 'short' })}</span>}
          {task.assignee_name && (
            <div className="avatar" style={{ background: task.assignee_color, fontSize: 9, width: 22, height: 22 }}>{initials(task.assignee_name)}</div>
          )}
        </div>
      </div>
    </div>
  );
}
