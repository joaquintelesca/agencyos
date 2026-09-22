const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

module.exports = function createProjectAccess({ db, io }) {
  async function isProjectMember(userId, role, projectId) {
    if (role === 'admin') return true;
    if (!projectId) return false;
    const member = await db('project_members').where({ project_id: projectId, user_id: userId }).first();
    return !!member;
  }

  async function addProjectMember(projectId, userId, role = 'member') {
    if (!projectId || !userId) return;
    // Upsert atómico con onConflict().ignore() en vez de "leer, después insertar si no existe": esa
    // secuencia tenía una carrera real bajo doble-click o dos requests casi simultáneos (ej. crear
    // tarea + asignar editor al mismo tiempo) — el segundo insert pisaba el unique(project_id,
    // user_id) y tiraba un 500 sin manejar en vez de simplemente no hacer nada.
    await db('project_members').insert({ project_id: projectId, user_id: userId, role }).onConflict(['project_id', 'user_id']).ignore();
  }

  // Se llama cuando alguien deja de ser el editor de un proyecto o deja de tener una tarea asignada
  // en él — reasignar no sacaba nunca al editor/tarea anterior de project_members, así que seguía
  // viendo el board, las tareas de otros, el chat y los videos del proyecto para siempre. Solo lo
  // saca si de verdad ya no tiene ningún motivo legítimo para seguir ahí (no es quien lo creó, no es
  // el editor actual, no le queda ninguna tarea asignada en ese proyecto) — si todavía le queda una
  // tarea suya sin terminar, por ejemplo, no le conviene perder el acceso solo porque el proyecto
  // como un todo pasó a otro editor.
  async function removeProjectMemberIfOrphaned(projectId, userId) {
    if (!projectId || !userId) return;
    const project = await db('projects').where({ id: projectId }).first();
    if (!project) return;
    if (project.created_by === userId || project.payment_editor_id === userId) return;
    const hasTask = await db('tasks').where({ project_id: projectId, assigned_to: userId }).first();
    if (hasTask) return;
    const deleted = await db('project_members').where({ project_id: projectId, user_id: userId }).delete();
    if (deleted) {
      // Además de la fila en la tabla, saca a cualquier socket ya conectado de ese usuario de la
      // room del proyecto — si no, sigue recibiendo mensajes de chat en vivo hasta que recargue.
      io.in(`user:${userId}`).socketsLeave(`project:${projectId}`);
    }
  }

  // Mismas columnas del kanban que TASK_COLUMNS en client/src/pages/Project.jsx — sin este chequeo,
  // un editor podía mandar cualquier string como status de su propia tarea (PUT /api/tasks/:id) y
  // corromper el campo, rompiendo tanto el render del kanban como las notificaciones de review/
  // feedback que comparan contra estos valores exactos.
  const TASK_STATUSES = ['todo', 'in_progress', 'review', 'feedback', 'done'];

  // Campos de plata de un proyecto — nunca deben llegar a un editor, ni por REST ni por socket.
  // Ocultarlos solo en la UI no alcanza (el JSON crudo de /api/projects sigue viajando entero al
  // navegador): tiene que ser el servidor el que no los mande.
  const PROJECT_FINANCIAL_FIELDS = [
    'payment_amount', 'client_amount', 'payment_type', 'payment_hours', 'payment_status',
    'editor_paid', 'client_paid', 'editor_paid_at', 'client_paid_at',
    'editor_paid_amount', 'client_paid_amount_gross', 'client_paid_amount_net',
    'upwork_status', 'upwork_fee_pct',
    'computed_editor_total', 'computed_client_gross', 'computed_client_net'
  ];
  function stripProjectFinancials(project) {
    if (!project) return project;
    const clean = { ...project };
    for (const f of PROJECT_FINANCIAL_FIELDS) delete clean[f];
    return clean;
  }

  // Si el editor asignado a un proyecto fue borrado de la base, el LEFT JOIN a `users` devuelve el
  // nombre en null pero payment_editor_id sigue apuntando a él (a propósito: no lo desasignamos para
  // no perder el historial de a quién se le pagó). Sin este fallback el proyecto queda mostrando
  // "editor asignado" pero con nombre vacío, que confunde más que aclarar qué pasó.
  function withDeletedEditorFallback(row, nameField = 'payment_editor_name') {
    if (row && row.payment_editor_id && !row[nameField]) row[nameField] = 'Editor eliminado';
    return row;
  }

  // Emite un evento solo a los miembros de un proyecto (via sus rooms personales) y a todos los
  // admins. Los no-admin reciben la versión sin campos de plata (stripProjectFinancials) POR
  // DEFECTO — antes era al revés (opt-in con `sanitizeForNonAdmin`), así que un endpoint nuevo que
  // se olvidara de pasar esa opción reintroducía la fuga de datos financieros sin que nadie lo
  // notara (pasó una vez, era exactamente este patrón). stripProjectFinancials es inofensivo sobre
  // payloads que no son proyectos (tareas, videos, comentarios no tienen esos campos, así que no
  // hace nada), por eso es seguro aplicarlo siempre. Para el caso — hoy inexistente — de necesitar
  // mandar el dato crudo a propósito, está `skipSanitize: true` como escape hatch explícito.
  async function emitToProject(projectId, event, data, { skipSanitize } = {}) {
    const memberIds = await db('project_members').where({ project_id: projectId }).pluck('user_id');
    const admins = await db('users').where({ role: 'admin' }).select('id');
    const adminIdSet = new Set(admins.map(a => a.id));
    const targetIds = new Set([...memberIds, ...adminIdSet]);
    const sanitized = skipSanitize ? data : stripProjectFinancials(data);
    for (const uid of targetIds) {
      io.to(`user:${uid}`).emit(event, adminIdSet.has(uid) ? data : sanitized);
    }
  }

  // Middleware: requiere ser miembro del proyecto indicado por :projectId (o admin).
  function requireProjectAccess(paramName = 'projectId') {
    return async (req, res, next) => {
      try {
        if (req.user.role === 'admin') return next();
        const projectId = req.params[paramName];
        if (!projectId) return res.status(400).json({ error: 'Proyecto no especificado' });
        const membership = await db('project_members')
          .where({ project_id: projectId, user_id: req.user.id }).first();
        if (!membership) return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
        next();
      } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
    };
  }

  // Rate limiting para login: previene ataques de fuerza bruta.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Demasiados intentos de inicio de sesión. Probá de nuevo más tarde.' }
  });

  // Los endpoints que abren una subida no tenían ningún límite: cada init reserva un multipart
  // real en R2 (facturable) y una entrada en uploadSessions que recién se barre a las 6h, así que
  // un token robado —o un bug de reintentos del cliente— podía inflar costo y memoria en un loop.
  // El límite es por usuario, no por IP: varios editores pueden compartir salida NAT, y el que
  // importa acá es quién sube, no desde dónde. Generoso a propósito: subir 40 videos en 15 minutos
  // no es un uso real, pero 10 sí podría serlo en un día de entrega.
  const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    // ipKeyGenerator normaliza IPv6 (agrupa por /64 en vez de por dirección exacta, que en IPv6
    // cambia por request) — usar req.ip crudo como fallback dejaba esquivar el límite y además
    // tiraba un warning de validación en cada arranque.
    keyGenerator: (req) => req.user?.id || ipKeyGenerator(req.ip),
    message: { error: 'Demasiadas subidas seguidas. Esperá unos minutos.' }
  });

  return {
    isProjectMember, addProjectMember, removeProjectMemberIfOrphaned,
    TASK_STATUSES, stripProjectFinancials, withDeletedEditorFallback,
    emitToProject, requireProjectAccess, loginLimiter, uploadLimiter,
  };
};
