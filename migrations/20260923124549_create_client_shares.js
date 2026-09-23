// Portal por cliente (además del link existente por video, video_shares): un solo token estable
// que muestra TODOS los proyectos activos y videos pendientes de ese cliente, en vez de un link
// nuevo por cada video. Misma forma exacta que video_shares (id/created_by/expires_at/revoked) a
// propósito — es el mismo modelo de acceso sin cuenta, solo que el scope es un cliente en vez de
// un video puntual.
exports.up = function(knex) {
  return knex.schema.createTable('client_shares', (t) => {
    t.string('id').primary();
    t.string('client_id').notNullable();
    t.string('created_by');
    t.timestamp('expires_at');
    t.boolean('revoked').defaultTo(false);
    t.timestamp('created_at').defaultTo(knex.fn.now());
    t.foreign('client_id').references('clients.id').onDelete('CASCADE');
    t.foreign('created_by').references('users.id').onDelete('SET NULL');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('client_shares');
};
