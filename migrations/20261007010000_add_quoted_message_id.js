/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    // Nullable: la gran mayoría de los mensajes no citan nada. No se valida FK estricta porque el
    // mensaje citado puede borrarse después (no hay borrado de mensajes hoy, pero no corresponde
    // asumirlo acá) — si no existe más, el cliente simplemente no muestra el bloque de cita.
    t.string('quoted_message_id').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    t.dropColumn('quoted_message_id');
  });
};
