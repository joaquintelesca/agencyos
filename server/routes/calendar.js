const express = require('express');
const { v4: uuidv4 } = require('uuid');

module.exports = function calendarRoutes({ db, auth }) {
  const router = express.Router();

  // Eventos propios (no deadlines de proyecto, esos salen de GET /api/projects) — del equipo
  // entero, no privados por usuario: cualquiera con sesión los ve y los crea.
  router.get('/api/calendar-events', auth, async (req, res) => {
    try {
      const events = await db('calendar_events').orderBy('date', 'asc');
      res.json(events);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  router.post('/api/calendar-events', auth, async (req, res) => {
    try {
      const { title, date, color } = req.body;
      if (!title?.trim()) return res.status(400).json({ error: 'Falta el título' });
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Fecha inválida' });
      const id = uuidv4();
      await db('calendar_events').insert({ id, title: title.trim().slice(0, 120), date, color: color || '#6366f1', created_by: req.user.id });
      const event = await db('calendar_events').where({ id }).first();
      res.json(event);
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Igual que borrar un comentario: el autor o un admin, no cualquiera con sesión.
  router.delete('/api/calendar-events/:id', auth, async (req, res) => {
    try {
      const event = await db('calendar_events').where({ id: req.params.id }).first();
      if (!event) return res.status(404).json({ error: 'No encontrado' });
      if (event.created_by !== req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Sin acceso' });
      }
      await db('calendar_events').where({ id: req.params.id }).delete();
      res.json({ success: true });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // El token es la única forma de "loguearse" que entiende una app de calendario externa (Google/
  // Apple Calendar solo pegan una URL, no inician sesión con usuario/contraseña) — se genera recién
  // la primera vez que se pide, no de entrada para todos los usuarios que capaz nunca lo usan.
  router.get('/api/calendar/feed-token', auth, async (req, res) => {
    try {
      let user = await db('users').where({ id: req.user.id }).first();
      if (!user.calendar_feed_token) {
        const token = uuidv4().replace(/-/g, '') + uuidv4().replace(/-/g, '');
        await db('users').where({ id: req.user.id }).update({ calendar_feed_token: token });
        user = { ...user, calendar_feed_token: token };
      }
      res.json({ token: user.calendar_feed_token });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
  });

  // Formatea una fecha YYYY-MM-DD como evento de "todo el día" en iCalendar — VALUE=DATE evita
  // cualquier lío de huso horario (no hay hora que convertir, es el día completo en cualquier zona).
  function icsDateLine(prefix, dateStr) {
    return `${prefix};VALUE=DATE:${dateStr.replace(/-/g, '')}`;
  }
  // Los saltos de línea y las comas/puntos y coma tienen significado especial en iCalendar — sin
  // escaparlos, un título de evento con una coma corta el campo a la mitad y rompe el archivo entero
  // para el resto de las apps de calendario que lo lean.
  function icsEscape(text) {
    return String(text || '').replace(/[\\,;]/g, m => `\\${m}`).replace(/\n/g, '\\n');
  }

  // Sin `auth`, a propósito — una app de calendario externa no puede mandar el header Authorization
  // de esta app, así que el ?token en la URL ES la autenticación acá (por eso es larga y random, y
  // por eso se avisa en el modal de "Suscribirse" que no hay que compartir el link).
  router.get('/api/calendar/feed.ics', async (req, res) => {
    try {
      const { token } = req.query;
      if (!token) return res.status(401).send('Falta el token');
      const user = await db('users').where({ calendar_feed_token: token }).first();
      if (!user) return res.status(401).send('Token inválido');

      let projectsQuery = db('projects as p')
        .leftJoin('clients as c', 'p.client_id', 'c.id')
        .where('p.status', '!=', 'completed')
        .whereNotNull('p.deadline')
        .select('p.id', 'p.name', 'p.deadline', 'c.name as client_name');
      if (user.role !== 'admin') {
        const memberProjectIds = await db('project_members').where({ user_id: user.id }).pluck('project_id');
        projectsQuery = projectsQuery.whereIn('p.id', memberProjectIds);
      }
      const projects = await projectsQuery;
      const events = await db('calendar_events');

      const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//AgencyOS//Calendar//ES', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:AgencyOS'];
      for (const p of projects) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:project-${p.id}@agencyos`);
        lines.push(icsDateLine('DTSTART', p.deadline));
        lines.push(`SUMMARY:${icsEscape(p.name)}`);
        if (p.client_name) lines.push(`DESCRIPTION:${icsEscape(p.client_name)}`);
        lines.push('END:VEVENT');
      }
      for (const ev of events) {
        lines.push('BEGIN:VEVENT');
        lines.push(`UID:event-${ev.id}@agencyos`);
        lines.push(icsDateLine('DTSTART', ev.date));
        lines.push(`SUMMARY:${icsEscape(ev.title)}`);
        lines.push('END:VEVENT');
      }
      lines.push('END:VCALENDAR');

      res.set('Content-Type', 'text/calendar; charset=utf-8');
      res.send(lines.join('\r\n'));
    } catch (e) { console.error(e); res.status(500).send('Error interno del servidor'); }
  });

  return router;
};
