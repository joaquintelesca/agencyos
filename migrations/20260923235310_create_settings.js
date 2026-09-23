// Configuración general de la agencia (branding del portal por ahora, extensible a futuro) —
// clave/valor genérico en vez de columnas fijas, para no necesitar una migración nueva cada vez
// que se agregue un ajuste más. `value` guarda JSON serializado; quién lo lee sabe su propia forma.
exports.up = function(knex) {
  return knex.schema.createTable('settings', (t) => {
    t.string('key').primary();
    t.text('value');
  });
};

exports.down = function(knex) {
  return knex.schema.dropTable('settings');
};
