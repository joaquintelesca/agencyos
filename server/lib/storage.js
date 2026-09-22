const {
  ListObjectsV2Command, ListMultipartUploadsCommand, AbortMultipartUploadCommand, DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

// El video es el archivo más grande y más frecuente en esta app; una sola conexión
// larga (multipart, un solo POST) no aguanta bien conexiones inestables — un corte
// a mitad de subida obligaba a reiniciar de cero. Se sube en partes de 5MB: si se
// corta la conexión, el cliente puede reconsultar cuánto se recibió y retomar ahí,
// sin perder lo ya subido.
module.exports = function createStorage({ db, useR2, s3, R2_BUCKET, uploadsDir }) {
  const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB
  const CHUNK_UPLOAD_TTL = 6 * 60 * 60 * 1000; // 6h — después de esto se considera abandonada
  const VIDEO_MAX_BYTES = 3 * 1024 * 1024 * 1024; // 3GB, igual al límite anterior de multer
  const STORAGE_WARN_BYTES = 20 * 1024 * 1024 * 1024; // 20GB
  const STORAGE_CACHE_TTL = 60_000; // 60 segundos
  const chunksDir = path.join(uploadsDir, '.chunks');
  if (!useR2 && !fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir, { recursive: true });

  // uploadId -> { userId, projectId, mimetype, ext, totalSize, receivedBytes, meta, createdAt,
  //   + disco local: tempPath
  //   + R2: key, r2UploadId, parts (Map<partNumber, {ETag, PartNumber}>) }
  const uploadSessions = new Map();

  // Aborta/limpia lo que haya quedado de una sesión, según el backend activo.
  async function discardUploadSession(session) {
    if (useR2) {
      await s3.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: session.key, UploadId: session.r2UploadId })).catch(() => {});
    } else {
      await fs.promises.unlink(session.tempPath).catch(() => {});
    }
  }

  // Barrido periódico de subidas abandonadas (pestaña cerrada a mitad de subida, etc.)
  // para no dejar temporales sueltos (en disco, o partes multipart facturables en R2) indefinidamente.
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of uploadSessions.entries()) {
      if (now - session.createdAt > CHUNK_UPLOAD_TTL) {
        discardUploadSession(session);
        uploadSessions.delete(id);
      }
    }
  }, 30 * 60 * 1000);

  let _storageCacheBytes = null;
  let _storageCacheTime = 0;

  // Versión async (fs.promises) — la versión sync bloqueaba el event loop entero (HTTP y
  // sockets de todos los usuarios) mientras escaneaba un directorio de uploads de varios GB.
  async function _scanUploadsSize(dir = uploadsDir) {
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) total += await _scanUploadsSize(fullPath);
        else total += (await fs.promises.stat(fullPath)).size;
      } catch {}
    }
    return total;
  }

  // Suma el tamaño de todos los objetos del bucket, paginando (ListObjectsV2 devuelve como
  // máximo 1000 objetos por página).
  async function _scanR2Size() {
    let total = 0, token;
    do {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token }));
      for (const obj of (listed.Contents || [])) total += obj.Size || 0;
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  async function getUploadsSize() {
    const now = Date.now();
    if (_storageCacheBytes !== null && (now - _storageCacheTime) < STORAGE_CACHE_TTL) return _storageCacheBytes;
    _storageCacheBytes = useR2 ? await _scanR2Size() : await _scanUploadsSize();
    _storageCacheTime = now;
    return _storageCacheBytes;
  }

  // Los archivos físicos se borran DESPUÉS de que la transacción de DB ya confirmó el delete
  // (ver comentario en safeUnlink) — si el proceso se cae justo en esa ventana, el archivo queda
  // huérfano para siempre. Barrido periódico: cualquier archivo (en R2 o en uploads/ local) que
  // no esté referenciado por ninguna fila de la DB, y que no sea sospechosamente reciente (podría
  // estar subiéndose en este momento), se borra.
  async function cleanupOrphanedFiles() {
    try {
      const [videoFiles, thumbFiles, commentFiles, replyFiles, chatFiles] = await Promise.all([
        db('videos').pluck('filename'),
        // Sin esto, cualquier thumbnail (POST /api/videos/:id/thumbnail) quedaba "no referenciado"
        // para este barrido y se borraba solo unas horas después de subido.
        db('videos').whereNotNull('thumbnail_filename').pluck('thumbnail_filename'),
        db('comment_attachments').pluck('filename'),
        db('reply_attachments').pluck('filename'),
        db('chat_messages').whereNotNull('file_url').pluck('file_url'),
      ]);
      const referenced = new Set([
        ...videoFiles, ...thumbFiles, ...commentFiles, ...replyFiles,
        ...chatFiles.map(u => u.split('/').pop()),
      ]);
      const ONE_HOUR = 60 * 60 * 1000;

      if (useR2) {
        let token;
        do {
          const listed = await s3.send(new ListObjectsV2Command({ Bucket: R2_BUCKET, ContinuationToken: token }));
          for (const obj of (listed.Contents || [])) {
            if (referenced.has(obj.Key)) continue;
            if (Date.now() - obj.LastModified.getTime() < ONE_HOUR) continue;
            await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: obj.Key })).catch(() => {});
          }
          token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (token);

        // Multipart uploads abandonados (subida cortada antes de llegar a un primer chunk fallido
        // que dispare la limpieza propia) no aparecen en ListObjectsV2 hasta completarse — hay que
        // barrerlos aparte, o quedan facturando storage sin que ninguna sesión los sepa referenciar.
        const abandoned = await s3.send(new ListMultipartUploadsCommand({ Bucket: R2_BUCKET })).catch(() => ({ Uploads: [] }));
        for (const up of (abandoned.Uploads || [])) {
          if (Date.now() - up.Initiated.getTime() < ONE_HOUR) continue;
          await s3.send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET, Key: up.Key, UploadId: up.UploadId })).catch(() => {});
        }
        return;
      }

      const entries = await fs.promises.readdir(uploadsDir, { withFileTypes: true });
      const candidates = entries.filter(e => e.isFile()).map(e => e.name);
      for (const name of candidates) {
        if (referenced.has(name)) continue;
        const filePath = path.join(uploadsDir, name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (Date.now() - stat.mtimeMs < ONE_HOUR) continue;
          await fs.promises.unlink(filePath);
        } catch {}
      }

      // El propio TTL de uploadSessions no alcanza si el proceso se reinicia (la Map en memoria
      // se pierde), así que este barrido también revisa .chunks/ por su cuenta: cualquier temporal
      // sin sesión activa y no reciente es una subida abandonada o huérfana por un reinicio.
      const chunkEntries = await fs.promises.readdir(chunksDir, { withFileTypes: true }).catch(() => []);
      for (const entry of chunkEntries) {
        if (!entry.isFile()) continue;
        if (uploadSessions.has(entry.name)) continue;
        const filePath = path.join(chunksDir, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          if (Date.now() - stat.mtimeMs < ONE_HOUR) continue;
          await fs.promises.unlink(filePath);
        } catch {}
      }
    } catch (e) { console.error('Error en limpieza de archivos huérfanos:', e); }
  }
  setInterval(cleanupOrphanedFiles, 6 * 60 * 60 * 1000); // cada 6h

  // Notificaciones leídas y viejas no aportan nada — sin esto la tabla crece sin límite para
  // siempre. Las no leídas nunca se borran, sin importar la antigüedad.
  async function pruneOldNotifications() {
    try {
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      await db('notifications').where({ read: true }).andWhere('created_at', '<', cutoff).delete();
    } catch (e) { console.error('Error podando notificaciones viejas:', e); }
  }
  setInterval(pruneOldNotifications, 24 * 60 * 60 * 1000); // 1 vez por día
  pruneOldNotifications();

  return {
    CHUNK_SIZE, CHUNK_UPLOAD_TTL, VIDEO_MAX_BYTES, STORAGE_WARN_BYTES,
    chunksDir, uploadSessions, discardUploadSession, getUploadsSize, cleanupOrphanedFiles,
  };
};
