/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.createTable('chat_reactions', (t) => {
    t.string('id').primary();
    t.string('message_id').notNullable();
    t.string('user_id').notNullable();
    t.string('emoji').notNullable();
    t.timestamp('created_at').defaultTo(knex.fn.now());
    // Un usuario reacciona con un emoji dado a lo sumo una vez por mensaje — un segundo click
    // sobre el mismo emoji es "sacar la reacción" (toggle), no sumarla de nuevo.
    t.unique(['message_id', 'user_id', 'emoji']);
    t.index('message_id');
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.dropTable('chat_reactions');
};
