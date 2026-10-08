/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('project_activity', (t) => {
    // Mismo patrón que notifications.group_count: varios comentarios seguidos del mismo actor
    // sobre el mismo video actualizan la última fila de la timeline en vez de crear una nueva por
    // cada uno — si no, un video con 20 comentarios sueltos deja 20 filas idénticas ("comentó en
    // X") que tapan el resto del historial del proyecto.
    t.integer('group_count').defaultTo(1);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('project_activity', (t) => {
    t.dropColumn('group_count');
  });
};
