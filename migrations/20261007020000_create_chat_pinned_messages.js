/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('chat_pinned_messages', (t) => {
    t.string('id').primary();
    // A diferencia de "guardar" (privado, por usuario), fijar es compartido — un mensaje está
    // fijado o no para toda la conversación, no por persona. Por eso message_id es único acá y
    // NO lleva user_id como parte de la clave (sí se guarda pinned_by, solo para mostrar "fijado
    // por X").
    t.string('message_id').notNullable().unique();
    t.string('pinned_by').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('chat_pinned_messages');
};
