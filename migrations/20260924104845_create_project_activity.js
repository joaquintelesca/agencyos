// Timeline de actividad por proyecto: hoy "quién hizo qué" está disperso entre el Kanban, el chat
// y los videos, y encima no hay forma de reconstruirlo retroactivamente — tasks.updated_at solo
// guarda CUÁNDO fue el último cambio, no la secuencia de estados por los que pasó. Esta tabla
// arranca a registrar eventos desde ahora en adelante (no se puede rellenar el pasado).
// actor_id/guest_name en vez de un solo campo, mismo patrón que notifications: un comentario o
// aprobación desde el link público de un cliente no tiene user_id.
exports.up = function(knex) {
  return knex.schema.createTable('project_activity', (t) => {
    t.string('id').primary();
    t.string('project_id').notNullable();
    t.string('type').notNullable();
    t.string('actor_id');
    t.string('guest_name');
    t.text('data'); // JSON con detalle específico del tipo (título de tarea, versión de video, etc.)
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.foreign('project_id').references('projects.id').onDelete('CASCADE');
    t.foreign('actor_id').references('users.id').onDelete('SET NULL');
    t.index(['project_id', 'created_at']);
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('project_activity');
};
