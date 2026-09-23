// Recordatorio de cobro pendiente: necesita saber desde cuándo un proyecto está "terminado y
// esperando que el cliente pague" para poder medir días hábiles desde ahí. `completed_at`
// (columna existente) no sirve para esto — significa "el día en que se saldó del todo" (ver
// PATCH /api/payments/:projectId), lo opuesto de lo que hace falta acá. Se setea en PATCH
// /api/projects/:id/status cada vez que el proyecto pasa a 'completed', y se limpia si se
// reabre — así un reabrir-y-volver-a-completar reinicia el reloj en vez de arrastrar la fecha
// original.
exports.up = function(knex) {
  return knex.schema.alterTable('projects', (t) => {
    t.timestamp('pending_collection_since').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('projects', (t) => {
    t.dropColumn('pending_collection_since');
  });
};
