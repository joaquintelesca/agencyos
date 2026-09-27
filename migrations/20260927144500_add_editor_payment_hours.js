// Hasta ahora payment_hours alimentaba el monto de LOS DOS lados (editor y cliente) para un
// proyecto por hora — pero a veces lo facturado al cliente (ej. horas cargadas en Upwork) no es
// lo mismo que lo que se le termina pagando al editor (ej. Upwork redondeó para arriba, o se
// negoció pagarle menos tiempo del tracker). NULL (el default, y lo que tiene cualquier proyecto
// existente) significa "todavía no hay excepción: el editor cobra las mismas horas que el
// cliente", exactamente el comportamiento de antes — solo cuando el admin carga un valor acá en
// Pagos (ver PATCH /api/payments/:projectId) el editor pasa a cobrar un número de horas propio,
// desacoplado de payment_hours.
exports.up = function(knex) {
  return knex.schema.alterTable('projects', (t) => {
    t.float('editor_payment_hours').nullable();
  });
};

exports.down = function(knex) {
  return knex.schema.alterTable('projects', (t) => {
    t.dropColumn('editor_payment_hours');
  });
};
