const express = require('express');

module.exports = function paymentsRoutes({ db, auth, io, withDeletedEditorFallback, withComputedTotals, computeEditorAmount, computeClientGrossAmount, computeClientNetAmount, OWNER_EMAIL }) {
  const router = express.Router();

  // Un proyecto pasa a Pagos cuando el admin lo marca "terminado" a mano (ver PATCH
  // /api/projects/:id/status), no por inferirlo de las tareas — con proyectos donde se van
  // sumando tareas con el tiempo, "todas las tareas en done" es una señal que se puede romper
  // apenas se agrega una tarea nueva a un proyecto que ya se había dado por terminado.
  // ever_completed (en vez de mirar status='completed' solo) para que reabrir un proyecto ya
  // pagado (ej. para un retoque) no lo haga desaparecer en silencio de acá y del Balance mensual
  // — pero OJO: un proyecto activo con un anticipo cobrado (client_paid sin haberse completado
  // nunca) NO debe aparecer acá, es información de bookkeeping del proyecto, no un "pago" listo
  // para trackear en esta sección.
  router.get('/api/payments', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const projects = await db('projects as p')
        .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        // Se exige editor asignado SALVO que ya haya plata registrada de un lado u otro: sin esta
        // excepción, dejar un proyecto ya cobrado en "Sin asignar" lo borraba de Pagos y encogía
        // retroactivamente el total de un mes ya cerrado, con las filas de plata todavía en la DB.
        .where(function() {
          this.whereNotNull('p.payment_editor_id')
            .orWhere('p.client_paid', 'cobrado')
            .orWhere('p.editor_paid', 'paid');
        })
        .where(function() { this.where('p.status', 'completed').orWhere('p.ever_completed', true); })
        .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'u.email as _editor_email', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
        .orderBy('p.created_at', 'desc');
      projects.forEach(p => { withDeletedEditorFallback(p, 'editor_name'); withComputedTotals(p); });
      res.json(projects);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Libro de movimientos para el Balance mensual: TODO proyecto con plata efectivamente registrada
  // de algún lado, sin importar si está terminado. Va aparte de GET /api/payments a propósito —
  // esa lista es "trabajo cerrado para trackear" y deja afuera a los activos con anticipo (decisión
  // explícita), pero el balance de un mes tiene que contar la plata por la fecha en que se movió.
  // Calculándolo sobre la lista filtrada, un anticipo cobrado en julio sobre un proyecto todavía
  // activo no figuraba en julio y recién aparecía (agrandando un mes ya cerrado) al terminarlo.
  // Los montos vienen congelados por withComputedTotals cuando el lado está saldado, así que un
  // mes cerrado no se mueve aunque después se corrijan horas o tarifas.
  router.get('/api/payments/ledger', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      const rows = await db('projects as p')
        .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where(function() { this.whereNotNull('p.client_paid_at').orWhereNotNull('p.editor_paid_at'); })
        .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'u.email as _editor_email', 'c.name as client_name', 'c.color as client_color')
        .orderBy('p.created_at', 'desc');
      rows.forEach(p => { withDeletedEditorFallback(p, 'editor_name'); withComputedTotals(p); });
      res.json(rows);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.patch('/api/payments/:projectId', auth, async (req, res) => {
    try {
      if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
      let found = false;
      let badValue = false;
      await db.transaction(async trx => {
        // Mismo lock de fila que PUT /api/projects/:id (ver comentario ahí): todo lo que compone el
        // monto (horas, tarifa, tipo de pago) se lee DESPUÉS de tomar el lock y dentro de la misma
        // transacción que lo congela, así que si alguien edita esos campos justo mientras se marca
        // "pagado"/"cobrado", una de las dos operaciones espera a la otra en vez de congelar un monto
        // calculado con datos que ya cambiaron a mitad de camino.
        const existing = await trx('projects').where({ id: req.params.projectId }).forUpdate().first();
        if (!existing) return;
        found = true;
        const { payment_hours, payment_status, upwork_status, payment_amount } = req.body;
        // Sin whitelist, un valor como 'Paid' se guardaba igual pero fallaba el === 'paid' de
        // withComputedTotals: el monto congelado se descartaba y el proyecto volvía a un total
        // calculado en vivo, con editor_paid_at ya en null. Plata mal reportada en silencio.
        // ('pending' queda aceptado porque es el default viejo que todavía existe en filas reales.)
        const invalid = (v, allowed) => v !== undefined && !allowed.includes(v);
        if (invalid(req.body.editor_paid, ['paid', 'unpaid'])
          || invalid(req.body.client_paid, ['cobrado', 'unpaid'])
          || invalid(upwork_status, ['No', 'Pendiente de carga', 'Cargado', 'pending'])) {
          badValue = true;
          return;
        }
        const update = {};
        if (payment_hours !== undefined) update.payment_hours = Math.max(0, parseFloat(payment_hours) || 0);
        if (payment_status !== undefined) update.payment_status = payment_status;
        if (upwork_status !== undefined) update.upwork_status = upwork_status;
        if (payment_amount !== undefined) update.payment_amount = Math.max(0, parseFloat(payment_amount) || 0);
        if (req.body.editor_paid !== undefined) {
          update.editor_paid = req.body.editor_paid;
          update.editor_paid_at = req.body.editor_paid === 'paid' ? new Date().toISOString() : null;
        }
        if (req.body.client_paid !== undefined) {
          update.client_paid = req.body.client_paid;
          update.client_paid_at = req.body.client_paid === 'cobrado' ? new Date().toISOString() : null;
        }
        if (Object.keys(update).length) await trx('projects').where({ id: req.params.projectId }).update(update);
        const current = await trx('projects').where({ id: req.params.projectId }).first();

        // Congelar el monto real en el momento exacto en que se marca pagado/cobrado — así un
        // proyecto por horas no cambia de monto en un mes ya cerrado solo porque después se
        // corrigieron las horas cargadas.
        const followUp = {};
        if (req.body.editor_paid !== undefined) {
          followUp.editor_paid_amount = current.editor_paid === 'paid' ? computeEditorAmount(current) : null;
        }
        if (req.body.client_paid !== undefined) {
          followUp.client_paid_amount_gross = current.client_paid === 'cobrado' ? computeClientGrossAmount(current) : null;
          followUp.client_paid_amount_net = current.client_paid === 'cobrado' ? computeClientNetAmount(current) : null;
        }
        // Cuando el editor asignado es el dueño de la agencia no hay pago real que registrar (no se
        // paga a sí mismo), así que ese lado cuenta como saldado — es la misma regla que ya aplica
        // Payments.jsx para mover el proyecto a "Saldados". Sin espejarla acá, esos proyectos nunca
        // sellaban completed_at: quedaban con "Saldado: —" y al fondo del historial ordenado por esa
        // fecha. Por email (OWNER_EMAIL), no por rol admin: un segundo admin asignado como editor sí
        // tiene que cobrar de verdad, aunque también pueda gestionar pagos en la app.
        const editorUser = current.payment_editor_id
          ? await trx('users').where({ id: current.payment_editor_id }).select('email').first()
          : null;
        const editorSettled = current.editor_paid === 'paid' || editorUser?.email === OWNER_EMAIL;
        const isCompleted = editorSettled && current.client_paid === 'cobrado';
        if (isCompleted && !current.completed_at) {
          followUp.completed_at = new Date().toISOString();
        } else if (!isCompleted && current.completed_at) {
          followUp.completed_at = null;
        }
        if (Object.keys(followUp).length) {
          await trx('projects').where({ id: req.params.projectId }).update(followUp);
        }
      });
      if (!found) return res.status(404).json({ error: 'Proyecto no encontrado' });
      if (badValue) return res.status(400).json({ error: 'Valor de estado de pago inválido' });
      const project = withDeletedEditorFallback(await db('projects as p')
        .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('p.id', req.params.projectId)
        .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'u.email as _editor_email', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
        .first(), 'editor_name');
      // Sin withComputedTotals los campos computed_* vuelven undefined y Payments.jsx reemplaza la
      // fila con esta respuesta: las tarjetas pasan a "$NaN" y el Balance mensual crashea al hacer
      // .toFixed() sobre undefined. Todo el resto de los endpoints de proyecto ya lo aplican.
      withComputedTotals(project);
      io.to('admins').emit('payment:updated', project);
      res.json(project);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  return router;
};
