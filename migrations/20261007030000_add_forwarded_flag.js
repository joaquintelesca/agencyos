/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    // Reenviar reusa quoted_message_id (ya existe) como referencia al original — este flag es
    // solo para que el cliente sepa si el bloque de arriba dice "Citando a X" (mismo hilo) o
    // "Reenviado de X" (vino de otra conversación), sin tener que inferirlo.
    t.boolean('forwarded').defaultTo(false);
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    t.dropColumn('forwarded');
  });
};
