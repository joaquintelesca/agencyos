/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.up = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    // Un solo nivel de hilo (como Slack): una respuesta siempre cuelga del mensaje ROOT, nunca de
    // otra respuesta — si alguien responde a una respuesta, el servidor la cuelga igual del root
    // real (ver POST .../reply). Un mensaje con esto en null es un mensaje normal del feed
    // principal; uno con esto seteado NO aparece en el feed principal, solo dentro de su hilo.
    t.string('thread_parent_id').nullable();
  });
};

/**
 * @param { import("knex").Knex } knex
 * @returns { Promise<void> }
 */
exports.down = function(knex) {
  return knex.schema.table('chat_messages', (t) => {
    t.dropColumn('thread_parent_id');
  });
};
