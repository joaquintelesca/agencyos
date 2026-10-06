/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('chat_saved_messages', (t) => {
    t.string('id').primary();
    t.string('message_id').notNullable();
    t.string('user_id').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    // Guardar es un toggle, no una lista con repetidos — un segundo "Guardar" sobre el mismo
    // mensaje es "sacarlo de guardados", mismo criterio que chat_reactions.
    t.unique(['message_id', 'user_id']);
    t.index('user_id');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('chat_saved_messages');
};
