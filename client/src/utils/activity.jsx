// Mismo criterio que notifications.jsx: un solo lugar para "qué ícono/texto le corresponde a cada
// tipo de evento", para que la timeline (Project.jsx) no tenga que reimplementarlo. `a.actor_name`
// viene del join en server/routes/activity.js; `a.guest_name` cuando la acción la hizo un cliente
// sin cuenta desde el link público (comentar, aprobar) — nunca los dos a la vez.
export function activityIcon(type) {
  if (type === 'task_created') return '📝';
  if (type === 'task_status_changed') return '↪️';
  if (type === 'task_assigned') return '👤';
  if (type === 'video_uploaded') return '🎬';
  if (type === 'video_approved') return '✅';
  if (type === 'comment_added') return '💬';
  if (type === 'payment_marked') return '💰';
  if (type === 'project_completed') return '🏁';
  if (type === 'project_reopened') return '↺';
  return '•';
}

const STATUS_LABELS = { todo: 'Por hacer', in_progress: 'En progreso', review: 'En revisión', feedback: 'Aplicar feedback', done: 'Listo' };

export function activityLabel(a) {
  const who = a.actor_name || a.guest_name || 'Alguien';
  const d = a.data || {};
  if (a.type === 'task_created') return <><strong>{who}</strong> creó la tarea "{d.title}"</>;
  if (a.type === 'task_status_changed') return <><strong>{who}</strong> movió "{d.title}" de {STATUS_LABELS[d.from] || d.from} a {STATUS_LABELS[d.to] || d.to}</>;
  if (a.type === 'task_assigned') return <><strong>{who}</strong> asignó "{d.title}" a {d.assignee_name || 'alguien'}</>;
  if (a.type === 'video_uploaded') return <><strong>{who}</strong> subió "{d.title}"{d.version ? ` (v${d.version})` : ''}</>;
  if (a.type === 'video_approved') return <><strong>{who}</strong> aprobó "{d.title}"{d.version ? ` (v${d.version})` : ''}</>;
  if (a.type === 'comment_added') return <><strong>{who}</strong> comentó en "{d.video_title}"</>;
  if (a.type === 'payment_marked') {
    const sideLabel = d.side === 'editor' ? 'al editor' : 'al cliente';
    const valueLabel = d.value === 'paid' || d.value === 'cobrado' ? 'pagado' : 'sin pagar';
    return <><strong>{who}</strong> marcó {sideLabel} como {valueLabel}</>;
  }
  if (a.type === 'project_completed') return <><strong>{who}</strong> marcó el proyecto como terminado</>;
  if (a.type === 'project_reopened') return <><strong>{who}</strong> reabrió el proyecto</>;
  return <><strong>{who}</strong> hizo un cambio</>;
}
