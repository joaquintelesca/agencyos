// Config de knex para el CLI (`npx knex migrate:make nombre_del_cambio`) — server/index.js corre
// las migraciones en runtime con su propia instancia de knex, así que este archivo es solo para
// generar/inspeccionar migraciones a mano desde la terminal, no se importa desde el server.
// Misma lógica de conexión que server/index.js: Postgres si hay DATABASE_URL (producción), si no
// SQLite local (desarrollo).
const path = require('path');

module.exports = {
  client: process.env.DATABASE_URL ? 'pg' : 'sqlite3',
  connection: process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false }
    : { filename: path.join(__dirname, 'agencyos.db') },
  useNullAsDefault: true,
  migrations: {
    directory: path.join(__dirname, 'migrations')
  }
};
