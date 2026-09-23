// Recordatorio de revisión pendiente: si un video queda esperando al cliente por más de N días
// hábiles sin que haya ni un comentario de invitado, se lo avisa al admin — no hay infraestructura
// de mail en esta app, así que el aviso es la campanita/notificación de escritorio de siempre, no
// un mail al cliente (el admin decide cómo hacer el seguimiento). Solo cuenta si el video
// efectivamente se compartió (video_shares o client_shares activo en el momento del chequeo):
// pedido explícito del usuario, ya que muchos videos se entregan directo sin pasar nunca por
// aprobación del cliente, y esos no deberían generar ruido acá.
module.exports = function createReviewReminders({ db, createNotification }) {
  const BUSINESS_DAYS_THRESHOLD = 2;

  // Días hábiles (lunes a viernes) entre dos fechas — un findes de por medio no cuenta como
  // "2 días sin respuesta" de la misma forma que 2 días de semana.
  function businessDaysBetween(from, to) {
    let count = 0;
    const cursor = new Date(from);
    cursor.setHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setHours(0, 0, 0, 0);
    while (cursor < end) {
      cursor.setDate(cursor.getDate() + 1);
      const day = cursor.getDay(); // 0 = domingo, 6 = sábado
      if (day !== 0 && day !== 6) count++;
    }
    return count;
  }

  // Sin esto, dos llamadas superpuestas (el disparo automático al construir + una llamada manual,
  // o en teoría el intervalo diario si un chequeo anterior todavía no terminó) pueden pisarse: las
  // dos leen "todavía no se avisó" antes de que ninguna termine de insertar la notificación, y el
  // mismo video termina notificado dos veces. Encontrado con un test que llamaba a esto dos veces
  // seguidas — no es un escenario real en producción (corre 1 vez por día), pero cuesta lo mismo
  // cerrarlo del todo que confiar en que nunca se superponga.
  let running = false;

  async function checkPendingReviews() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const candidates = await db('videos as v')
        .join('projects as p', 'v.project_id', 'p.id')
        .where('p.status', 'active')
        .whereNull('v.approved_at')
        .select('v.id', 'v.title', 'v.created_at', 'v.project_id', 'p.client_id');

      for (const video of candidates) {
        // Un solo recordatorio por video, para siempre — no uno nuevo cada día que sigue sin
        // resolverse.
        const already = await db('notifications').where({ video_id: video.id, type: 'review_pending' }).first();
        if (already) continue;

        // Si el cliente ya comentó, la pelota está del lado de la agencia (aplicar el feedback),
        // no tiene sentido "recordarle" al admin que mire algo que el cliente ya miró y respondió.
        const hasGuestComment = await db('video_comments').where({ video_id: video.id }).whereNotNull('guest_name').first();
        if (hasGuestComment) continue;

        const videoShare = await db('video_shares')
          .where({ video_id: video.id, revoked: false })
          .where(function() { this.whereNull('expires_at').orWhere('expires_at', '>', now.toISOString()); })
          .orderBy('created_at', 'asc')
          .first();
        let clientShare = null;
        if (video.client_id) {
          clientShare = await db('client_shares')
            .where({ client_id: video.client_id, revoked: false })
            .where(function() { this.whereNull('expires_at').orWhere('expires_at', '>', now.toISOString()); })
            .orderBy('created_at', 'asc')
            .first();
        }
        const shares = [videoShare, clientShare].filter(Boolean);
        if (shares.length === 0) continue; // nunca se compartió con el cliente — no molesta

        // El reloj arranca cuando el video EXISTE Y está compartido a la vez — lo que pase después
        // entre esos dos eventos (subido antes de compartir, o compartido antes de subir un video
        // a un proyecto ya con portal activo).
        const earliestShareAt = shares.reduce(
          (min, s) => (!min || new Date(s.created_at) < new Date(min)) ? s.created_at : min, null
        );
        const referenceDate = new Date(Math.max(new Date(video.created_at).getTime(), new Date(earliestShareAt).getTime()));

        if (businessDaysBetween(referenceDate, now) < BUSINESS_DAYS_THRESHOLD) continue;

        const admins = await db('users').where({ role: 'admin' }).select('id');
        for (const admin of admins) {
          await createNotification({ userId: admin.id, type: 'review_pending', projectId: video.project_id, videoId: video.id, preview: video.title });
        }
      }
    } catch (e) { console.error('Error revisando recordatorios de revisión pendiente:', e); }
    finally { running = false; }
  }

  setInterval(checkPendingReviews, 24 * 60 * 60 * 1000); // 1 vez por día
  checkPendingReviews();

  return { checkPendingReviews, businessDaysBetween };
};
