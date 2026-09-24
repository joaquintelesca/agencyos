const { v4: uuidv4 } = require('uuid');

// Registra un evento en la timeline del proyecto — mismo criterio de "no propagar" que
// createNotification (server/index.js): si falla el log de actividad no debe tirar abajo la
// acción real del usuario (crear la tarea, subir el video, etc.), en el peor caso se pierde una
// entrada de la timeline, no el trabajo del usuario.
module.exports = function createActivityLogger({ db }) {
  async function logActivity({ projectId, type, actorId, guestName, data }) {
    try {
      await db('project_activity').insert({
        id: uuidv4(), project_id: projectId, type,
        actor_id: actorId || null, guest_name: guestName || null,
        data: data ? JSON.stringify(data) : null,
      });
    } catch (e) { console.error('Error registrando actividad (no se propaga):', e); }
  }
  return { logActivity };
};
