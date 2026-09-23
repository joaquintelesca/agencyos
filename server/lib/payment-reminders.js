// Recordatorio de cobro pendiente: espejo de review-reminders.js, pero del lado de la plata — si
// un proyecto quedó marcado "terminado" hace más de N días hábiles y el cliente todavía no lo
// pagó, se lo avisa al admin (campanita/notificación de escritorio, no hay mail). El reloj arranca
// en `pending_collection_since` (ver migración), que se pisa cada vez que el proyecto pasa a
// 'completed' y se limpia si se reabre — así un reabrir-y-completar-de-nuevo reinicia el conteo en
// vez de arrastrar la fecha del ciclo anterior.
const { businessDaysBetween } = require('./business-days');
const { computeClientNetAmount } = require('./payments');

module.exports = function createPaymentReminders({ db, createNotification }) {
  const BUSINESS_DAYS_THRESHOLD = 5;

  let running = false;

  async function checkPendingPayments() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const candidates = await db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('p.status', 'completed')
        .whereNot('p.client_paid', 'cobrado')
        .whereNotNull('p.pending_collection_since')
        .select('p.*', 'c.name as client_name');

      for (const project of candidates) {
        // Proyectos sin plata real de cliente registrada (ej. favor interno) no deberían generar
        // un recordatorio de cobro — no hay nada que cobrar.
        if (computeClientNetAmount(project) <= 0) continue;

        if (businessDaysBetween(project.pending_collection_since, now) < BUSINESS_DAYS_THRESHOLD) continue;

        // Un solo recordatorio por ciclo: si ya se avisó DESPUÉS de que arrancó este ciclo de
        // "pendiente de cobro" (pending_collection_since), no insistir. Comparar contra esa fecha
        // en vez de solo "ya existe una notificación de este tipo para este proyecto" es lo que
        // permite que reabrir y volver a completar el proyecto sin cobrar en el medio dispare un
        // aviso nuevo en el ciclo siguiente.
        const already = await db('notifications')
          .where({ project_id: project.id, type: 'payment_pending' })
          .where('created_at', '>=', project.pending_collection_since)
          .first();
        if (already) continue;

        const admins = await db('users').where({ role: 'admin' }).select('id');
        for (const admin of admins) {
          await createNotification({ userId: admin.id, type: 'payment_pending', projectId: project.id, preview: project.name });
        }
      }
    } catch (e) { console.error('Error revisando recordatorios de cobro pendiente:', e); }
    finally { running = false; }
  }

  setInterval(checkPendingPayments, 24 * 60 * 60 * 1000); // 1 vez por día
  checkPendingPayments();

  return { checkPendingPayments };
};
