/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('tasks', (t) => {
    // Bitácora de horas por tarea — JSON array de {etapa, horas, cargado, pagado}. Puramente
    // informativo/de control para el admin (pedido explícito del usuario: no toca Pagos ni ningún
    // cálculo de monto). Solo el admin la ve y la edita — server/routes/tasks.js la saca de la
    // respuesta para cualquier otro rol.
    t.text('hours_log').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('tasks', (t) => {
    t.dropColumn('hours_log');
  });
};
