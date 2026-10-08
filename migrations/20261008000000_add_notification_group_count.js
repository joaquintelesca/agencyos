/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('notifications', (t) => {
    // Cuántos eventos se agruparon en esta fila (ver createNotificationInner) — varios comentarios
    // seguidos de la misma persona sobre el mismo video actualizan la misma notificación no leída
    // en vez de crear una nueva por cada uno, y acá se lleva la cuenta para mostrar "N comentarios
    // nuevos" en vez de perder la noción de cuántos hubo.
    t.integer('group_count').defaultTo(1);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('notifications', (t) => {
    t.dropColumn('group_count');
  });
};
