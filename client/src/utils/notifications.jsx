// Compartido entre la página de Notificaciones y el toast del Layout — antes cada uno iba a
// terminar con su propia copia de "qué ícono/texto le corresponde a cada tipo", que se
// desalinean solas con el tiempo (agregás un tipo nuevo en un lado y te olvidás del otro).
export function notificationIcon(type) {
  if (type === 'comment') return '💬';
  if (type === 'reply') return '↩️';
  if (type === 'comment_resolved') return '☑️';
  if (type === 'task_review') return '📋';
  if (type === 'task_feedback') return '📝';
  if (type === 'task_done') return '🏁';
  if (type === 'video_uploaded') return '🎬';
  if (type === 'video_approved') return '✅';
  if (type === 'project_assigned') return '📁';
  if (type === 'task_assigned') return '✅';
  if (type === 'project_message') return '💬';
  if (type === 'mention') return '📣';
  return '✉️';
}

export function notificationLabel(n) {
  const proj = n.project_name ? <> · <span style={{ color: 'var(--text3)' }}>{n.project_name}</span></> : '';
  if (n.type === 'comment') return <><strong>{n.actor_name}</strong> comentó en un video{proj}</>;
  if (n.type === 'reply') return <><strong>{n.actor_name}</strong> respondió tu comentario{proj}</>;
  if (n.type === 'comment_resolved') return <><strong>{n.actor_name}</strong> resolvió tu comentario{proj}</>;
  if (n.type === 'task_review') return <><strong>{n.actor_name}</strong> pasó una tarea a revisión{proj}</>;
  if (n.type === 'task_feedback') return <><strong>{n.actor_name}</strong> te dejó feedback para aplicar en una tarea{proj}</>;
  if (n.type === 'task_done') return <><strong>{n.actor_name}</strong> terminó una tarea{proj}</>;
  if (n.type === 'video_uploaded') return <><strong>{n.actor_name}</strong> subió un video{n.preview ? <>: "{n.preview}"</> : ''}{proj}</>;
  if (n.type === 'video_approved') return <><strong>{n.actor_name}</strong> aprobó un video{n.preview ? <>: "{n.preview}"</> : ''}{proj}</>;
  if (n.type === 'project_assigned') return <><strong>{n.actor_name}</strong> te asignó un proyecto{proj}</>;
  if (n.type === 'task_assigned') return <><strong>{n.actor_name}</strong> te asignó una tarea{proj}</>;
  if (n.type === 'project_message') return <><strong>{n.actor_name}</strong> escribió en el chat del proyecto{proj}</>;
  if (n.type === 'mention') return <><strong>{n.actor_name}</strong> te mencionó{proj}</>;
  return <><strong>{n.actor_name}</strong> te envió un mensaje</>;
}

// A dónde navegar al clickear una notificación (página completa o toast) — un solo lugar para
// no repetir esta cadena de ifs en cada lado que necesite abrir lo que la notificación anuncia.
export function notificationTarget(n) {
  if (n.video_id && n.project_id) return `/project/${n.project_id}?tab=videos&video=${n.video_id}`;
  // Antes esto llevaba a /project/:id a secas, que abre la pestaña Kanban por default — el
  // mensaje que la notificación anuncia quedaba igual de escondido, había que ir a buscarlo.
  // Con chat_message_id (agregado después de esto) va además al mensaje puntual, no solo a la
  // pestaña — pero notificaciones viejas, creadas antes de ese fix, no lo tienen: caen sin el
  // parámetro y el chat se abre igual, sin el scroll-to-message.
  if ((n.type === 'project_message' || n.type === 'mention') && n.project_id) {
    const msgParam = n.chat_message_id ? `&message=${n.chat_message_id}` : '';
    return `/project/${n.project_id}?tab=chat${msgParam}`;
  }
  if (n.project_id) return `/project/${n.project_id}`;
  return null;
}
