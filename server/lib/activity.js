const { v4: uuidv4 } = require('uuid');

// Registra un evento en la timeline del proyecto — mismo criterio de "no propagar" que
// createNotification (server/index.js): si falla el log de actividad no debe tirar abajo la
// acción real del usuario (crear la tarea, subir el video, etc.), en el peor caso se pierde una
// entrada de la timeline, no el trabajo del usuario.
// Tipos de evento donde vale la pena agrupar: el mismo actor puede dejar varios comentarios
// seguidos en un video, y cada uno generaba su propia fila "comentó en X" — con 20 comentarios la
// timeline quedaba tapada por ese único video. Mismo criterio que notifications.group_count
// (server/index.js), pero acá no hay noción de "leído" que acote la ventana de agrupación, así que
// se agrupa solo con la fila MÁS RECIENTE del proyecto (eventos consecutivos), no con cualquier
// fila anterior que matchee.
const GROUPABLE_TYPES = new Set(['comment_added']);

module.exports = function createActivityLogger({ db }) {
  async function logActivity({ projectId, type, actorId, guestName, data }) {
    try {
      // `created_at` se fija acá (vs. dejar que el default de la columna lo resuelva en el
      // INSERT) porque el default de SQLite (CURRENT_TIMESTAMP) solo tiene resolución de
      // segundo — dos eventos dentro del mismo segundo quedan empatados y "ordenar por
      // created_at desc" para encontrar "la última fila" ya no es confiable. Mismo formato
      // "YYYY-MM-DD HH:MM:SS.mmm" que ya usa la columna, solo que con milisegundos agregados, para
      // que siga ordenando bien lexicográficamente junto a filas viejas sin milisegundos.
      const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
      if (GROUPABLE_TYPES.has(type)) {
        const last = await db('project_activity').where({ project_id: projectId }).orderBy('created_at', 'desc').first();
        if (last && last.type === type && (last.actor_id || null) === (actorId || null) && (last.guest_name || null) === (guestName || null)) {
          const lastData = last.data ? JSON.parse(last.data) : {};
          if (lastData.video_title === data?.video_title) {
            await db('project_activity').where({ id: last.id }).update({
              data: data ? JSON.stringify(data) : last.data,
              group_count: (last.group_count || 1) + 1,
              created_at: now,
            });
            return;
          }
        }
      }
      await db('project_activity').insert({
        id: uuidv4(), project_id: projectId, type,
        actor_id: actorId || null, guest_name: guestName || null,
        data: data ? JSON.stringify(data) : null,
        created_at: now,
      });
    } catch (e) { console.error('Error registrando actividad (no se propaga):', e); }
  }
  return { logActivity };
};
