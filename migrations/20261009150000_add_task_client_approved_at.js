/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('tasks', (t) => {
    // Pedido puntual del cliente CUURT: una columna extra en SU Kanban ("Aprobado por cliente"),
    // que no es un estado nuevo del flujo de trabajo (todo/in_progress/review/feedback/done) sino
    // un check adicional sobre una tarea ya en 'done' — así el resto de la app (Dashboard, Team,
    // progreso del proyecto) que cuenta "done" como "terminado" sigue funcionando exactamente
    // igual sin tener que tocar esas queries. Ver Project.jsx para el detalle de cómo se arma la
    // columna extra solo para los proyectos de ese cliente.
    t.datetime('client_approved_at').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('tasks', (t) => {
    t.dropColumn('client_approved_at');
  });
};
