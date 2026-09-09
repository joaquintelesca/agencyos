import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import VideoReview from '../components/VideoReview';
import { initials } from '../utils/format';

const STATUSES = [
  { key: 'todo', label: 'Por hacer', color: 'var(--text2)' },
  { key: 'in_progress', label: 'En progreso', color: 'var(--blue)' },
  { key: 'review', label: 'En revisión', color: 'var(--yellow)' },
  { key: 'done', label: 'Listo', color: 'var(--green)' },
];
const PRIORITIES = ['low', 'medium', 'high'];

export default function Project() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const { api, user, socket } = useAuth();
  const [project, setProject] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  const [messages, setMessages] = useState([]);
  const [tab, setTab] = useState(searchParams.get('tab') || 'kanban');
  const [newMsg, setNewMsg] = useState('');
  const [showTaskModal, setShowTaskModal] = useState(false);
  const [editingTask, setEditingTask] = useState(null);
  const [taskForm, setTaskForm] = useState({ title: '', description: '', status: 'todo', priority: 'medium', assigned_to: '', due_date: '' });
  const [dragTask, setDragTask] = useState(null);
  const [reviewReminderTask, setReviewReminderTask] = useState(null);
  const [uploadForTaskId, setUploadForTaskId] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const msgEndRef = useRef(null);
  const msgContainerRef = useRef(null);

  useEffect(() => {
    setProject(null);
    setNotFound(false);
    setTasks([]);
    setMessages([]);
    api(`/api/projects/${id}`).then(setProject).catch(e => {
      console.error(e);
      setNotFound(true);
    });
    api(`/api/projects/${id}/tasks`).then(setTasks);
    api(`/api/projects/${id}/messages`).then(msgs => { setMessages(msgs); setHasMore(msgs.length >= 50); });
    api('/api/users').then(setUsers);
  }, [id]);

  // Deep link desde una notificación (?tab=videos): si ya estamos en este proyecto, React Router
  // no remonta el componente al cambiar solo el query param, así que hay que resincronizar el tab.
  useEffect(() => {
    const t = searchParams.get('tab');
    if (t && t !== tab) setTab(t);
  }, [searchParams]); // eslint-disable-line

  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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
    setTaskForm({ title: '', description: '', status, priority: 'medium', assigned_to: '', due_date: '' });
    setShowTaskModal(true);
  };

  const openEditTask = (task) => {
    setEditingTask(task);
    setTaskForm({ title: task.title, description: task.description || '', status: task.status, priority: task.priority, assigned_to: task.assigned_to || '', due_date: task.due_date || '' });
    setShowTaskModal(true);
  };

  const saveTask = async () => {
    if (!taskForm.title.trim()) return;
    if (editingTask) {
      await api(`/api/tasks/${editingTask.id}`, { method: 'PUT', body: taskForm });
    } else {
      await api(`/api/projects/${id}/tasks`, { method: 'POST', body: taskForm });
    }
    setShowTaskModal(false);
  };

  const deleteTask = async (taskId) => {
    if (!confirm('¿Eliminar esta tarea?')) return;
    await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
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
    }, (err, response) => {
      if (err || response?.error) {
        const reason = err ? 'sin respuesta del servidor' : response.error;
        // Si mientras tanto ya empezaste a escribir otra cosa, no la pisamos — pero tampoco
        // podemos perder el texto que falló en silencio, así que va en el aviso.
        setNewMsg(prev => {
          if (prev) {
            alert(`No se pudo enviar el mensaje (${reason}). Tu mensaje sin enviar era: "${content}"`);
            return prev;
          }
          alert(`No se pudo enviar el mensaje (${reason}). Reintentá.`);
          return content;
        });
      }
    });
  };

  const onDragStart = (task) => setDragTask(task);
  const onDrop = async (status) => {
    const task = dragTask;
    setDragTask(null);
    if (!task || task.status === status) return;
    try {
      // Solo se manda el campo que cambió: mandar la tarea entera (snapshot capturado al
      // agarrarla) podía pisar una edición concurrente de otra persona con datos viejos.
      await api(`/api/tasks/${task.id}`, { method: 'PUT', body: { status } });
      if (status === 'review' && task.status !== 'review') {
        setReviewReminderTask({ ...task, status });
      }
    } catch (e) {
      alert('Error al mover la tarea: ' + e.message);
    }
  };

  const formatTime = (ts) => new Date(ts).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

  if (notFound) return (
    <div className="empty" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
      <div className="empty-icon">🔍</div>
      <p>Proyecto no encontrado</p>
      <Link to="/" className="btn btn-primary" style={{ marginTop: 12 }}>Volver al dashboard</Link>
    </div>
  );

  if (!project) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}><div className="spinner" /></div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ padding: '0 24px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 56, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: project.color }} />
          <h2 style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: 18 }}>{project.name}</h2>
          <span style={{ fontSize: 12, color: 'var(--text3)', background: 'var(--bg3)', padding: '2px 8px', borderRadius: 8 }}>{tasks.length} tareas</span>
          {project.payment_editor_name && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 20, height: 20, borderRadius: '50%', background: project.payment_editor_color || 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 8, fontWeight: 700, color: '#fff' }}>{initials(project.payment_editor_name)}</div>
              <span style={{ fontSize: 12, color: 'var(--text2)' }}>{project.payment_editor_name}</span>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {['kanban', 'chat', 'videos'].map(t => (
            <button key={t} onClick={() => setTab(t)} style={{
              padding: '6px 14px', borderRadius: 8, border: 'none', fontFamily: 'var(--font)', fontSize: 13,
              cursor: 'pointer', fontWeight: tab === t ? 600 : 400,
              background: tab === t ? 'var(--bg3)' : 'transparent',
              color: tab === t ? 'var(--text)' : 'var(--text2)',
            }}>
              {t === 'kanban' ? '📋 Tareas' : t === 'chat' ? '💬 Chat' : '🎬 Videos'}
            </button>
          ))}
        </div>
      </div>

      {/* Kanban */}
      {tab === 'kanban' && (
        <div style={{ display: 'flex', gap: 12, padding: 20, overflowX: 'auto', flex: 1 }}>
          {STATUSES.map(col => (
            <div key={col.key} style={{ width: 250, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
              onDragOver={e => e.preventDefault()} onDrop={() => onDrop(col.key)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10, padding: '0 4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                  <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: col.color }}>{col.label}</span>
                  <span style={{ fontSize: 11, background: 'var(--bg3)', color: 'var(--text3)', padding: '1px 7px', borderRadius: 8 }}>
                    {tasks.filter(t => t.status === col.key).length}
                  </span>
                </div>
                {user.role === 'admin' && <button onClick={() => openCreateTask(col.key)} style={{ background: 'transparent', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>＋</button>}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                {tasks.filter(t => t.status === col.key).map(task => (
                  <TaskCard key={task.id} task={task}
                    onEdit={user.role === 'admin' ? () => openEditTask(task) : null}
                    onDelete={user.role === 'admin' ? () => deleteTask(task.id) : null}
                    onDragStart={() => onDragStart(task)} initials={initials}
                    canDrag={user.role === 'admin' || task.assigned_to === user.id} />
                ))}
              </div>
              {user.role === 'admin' && (
                <button onClick={() => openCreateTask(col.key)} style={{
                  marginTop: 8, padding: '8px', borderRadius: 8, border: '1px dashed var(--border)',
                  background: 'transparent', color: 'var(--text3)', fontSize: 12, cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'center'
                }}>
                  ＋ Agregar tarea
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
                <div key={m.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexDirection: isMine ? 'row-reverse' : 'row', marginTop: showAvatar ? 12 : 2 }}>
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
                      fontSize: 14, lineHeight: 1.5
                    }}>{m.content}</div>
                    <div style={{ fontSize: 10, color: 'var(--text3)', marginTop: 3, textAlign: isMine ? 'right' : 'left' }}>{formatTime(m.created_at)}</div>
                  </div>
                </div>
              );
            })}
            <div ref={msgEndRef} />
          </div>
          <form onSubmit={sendMessage} style={{ padding: '12px 24px', borderTop: '1px solid var(--border)', display: 'flex', gap: 10 }}>
            <input className="input" value={newMsg} onChange={e => setNewMsg(e.target.value)} placeholder={`Mensaje en ${project.name}...`} style={{ flex: 1 }} />
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

      {/* Task Modal */}
      {showTaskModal && (
        <div className="modal-overlay" onClick={() => setShowTaskModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>{editingTask ? 'Editar tarea' : 'Nueva tarea'}</h2>
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
              <button className="btn btn-primary" onClick={saveTask}>{editingTask ? 'Guardar' : 'Crear'}</button>
            </div>
          </div>
        </div>
      )}

      {reviewReminderTask && (
        <div className="modal-overlay" onClick={() => setReviewReminderTask(null)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Tarea en revisión</h2>
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
    </div>
  );
}

function TaskCard({ task, onEdit, onDelete, onDragStart, initials, canDrag = true }) {
  const priorityColors = { high: 'var(--red)', medium: 'var(--yellow)', low: 'var(--green)' };
  const priorityLabels = { high: 'Alta', medium: 'Media', low: 'Baja' };
  return (
    <div draggable={canDrag} onDragStart={canDrag ? onDragStart : undefined} onClick={onEdit || undefined} style={{
      background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 10,
      padding: '12px 14px', cursor: canDrag || onEdit ? 'pointer' : 'default', transition: 'all 0.15s',
    }}
    onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border2)'}
    onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}>
      <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', lineHeight: 1.45, marginBottom: 10 }}>{task.title}</div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 7px', borderRadius: 8, background: `${priorityColors[task.priority]}18`, color: priorityColors[task.priority] }}>
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
