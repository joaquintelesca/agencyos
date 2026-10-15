/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('clients', (t) => {
    // "Clientes archivados" en el sidebar — clientes viejos con los que ya no se trabaja, pero sin
    // borrarlos (sus proyectos pasados siguen vivos, solo se sacan de la vista principal). Puramente
    // de UI: no afecta Pagos, Dashboard, ni el selector de cliente al crear un proyecto.
    t.timestamp('archived_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('clients', (t) => {
    t.dropColumn('archived_at');
  });
};
