const { PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Backup diario de toda la base — Supabase free no incluye backups automáticos (eso es Supabase
// Pro), y ni siquiera hace falta pagarlo: un dump de texto de esta base (todo menos los videos en
// sí, que ya viven aparte en R2) pesa unos pocos MB, así que 30 días de backups entran cómodos en
// el mismo R2 sin costo real.
//
// Se guardan los últimos 30 (cola FIFO: entra uno nuevo, sale el más viejo si ya hay 30) — nunca
// solo el más reciente, a propósito: pedido explícito del usuario tras la explicación de que el
// caso de uso típico de un backup es notar un error unos días después de que pasó, y ahí el
// backup de ayer ya tiene el mismo error adentro.
module.exports = function createBackup({ db, useR2, s3, R2_BUCKET, uploadsDir }) {
  const RETENTION = 30;
  const PREFIX = 'backups/';
  const localBackupsDir = path.join(uploadsDir, '..', 'backups');

  // knex_migrations/knex_migrations_lock son bookkeeping de Knex, no datos de la agencia — se
  // descubren las tablas reales en vez de mantener una lista a mano, que quedaría desactualizada
  // cada vez que se agrega una tabla nueva (pasó varias veces esta misma semana).
  async function listTables() {
    const isPg = db.client.config.client === 'pg';
    if (isPg) {
      const { rows } = await db.raw("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename NOT LIKE 'knex_%'");
      return rows.map(r => r.tablename);
    }
    const rows = await db.raw("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'knex_%' AND name NOT LIKE 'sqlite_%'");
    return rows.map(r => r.name);
  }

  async function dumpDatabase() {
    const tables = await listTables();
    const dump = {};
    for (const table of tables) dump[table] = await db(table).select('*');
    return dump;
  }

  // Nombre = fecha (YYYY-MM-DD), así el orden alfabético ya es el orden cronológico — no hace
  // falta leer metadata de cada objeto para saber cuáles son los más viejos.
  function keyFor(date) { return `${PREFIX}agencyos-${date}.json.gz`; }

  // Devuelve {key, size, modified} por cada backup existente, más viejo primero — el nombre
  // codifica la fecha, así que el orden alfabético ya es el orden cronológico.
  async function listBackups() {
    if (useR2) {
      let items = [], token;
      do {
        const listed = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, Prefix: PREFIX, ContinuationToken: token }));
        items.push(...(listed.Contents || []).map(o => ({ key: o.Key, size: o.Size, modified: o.LastModified })));
        token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
      } while (token);
      return items.sort((a, b) => a.key.localeCompare(b.key));
    }
    if (!fs.existsSync(localBackupsDir)) return [];
    return fs.readdirSync(localBackupsDir).filter(f => f.endsWith('.json.gz')).sort().map(f => {
      const stat = fs.statSync(path.join(localBackupsDir, f));
      return { key: `${PREFIX}${f}`, size: stat.size, modified: stat.mtime };
    });
  }

  async function pruneOldBackups() {
    const backups = await listBackups();
    const keys = backups.map(b => b.key);
    const toDelete = keys.slice(0, Math.max(0, keys.length - RETENTION));
    for (const key of toDelete) {
      if (useR2) { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })).catch(() => {}); continue; }
      try { fs.unlinkSync(path.join(localBackupsDir, key.slice(PREFIX.length))); } catch {}
    }
  }

  let running = false;
  async function runBackup() {
    if (running) return;
    running = true;
    try {
      const dump = await dumpDatabase();
      const gz = zlib.gzipSync(JSON.stringify(dump));
      const date = new Date().toISOString().slice(0, 10);
      const key = keyFor(date);

      if (useR2) {
        await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: gz, ContentType: 'application/gzip' }));
      } else {
        fs.mkdirSync(localBackupsDir, { recursive: true });
        fs.writeFileSync(path.join(localBackupsDir, `agencyos-${date}.json.gz`), gz);
      }
      await pruneOldBackups();
      console.log(`✅ Backup diario guardado: ${key} (${(gz.length / 1024).toFixed(0)} KB)`);
    } catch (e) { console.error('Error generando el backup diario:', e); }
    finally { running = false; }
  }

  setInterval(runBackup, 24 * 60 * 60 * 1000); // 1 vez por día
  runBackup();

  return { runBackup, listBackups };
};
