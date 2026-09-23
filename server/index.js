const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const knex = require('knex');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
// Sin esto, pg devuelve las columnas `date` como objetos Date (parseados a medianoche UTC), que al
// serializar a JSON quedan como "2026-09-01T00:00:00.000Z" en vez de "2026-09-01" — rompe tanto el
// cálculo de "días restantes" del deadline (que espera YYYY-MM-DD) como el <input type="date"> del
// cliente (que ignora un value que no matchee ese formato exacto).
require('pg').types.setTypeParser(1082, val => val);
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const helmet = require('helmet');
const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// 'file-type' es ESM-only (no se puede require() desde CommonJS) — se carga una sola vez con
// import() dinámico y se cachea la promesa para no repetir el import en cada verificación.
let _fileTypePromise = null;
function getFileType() {
  if (!_fileTypePromise) _fileTypePromise = import('file-type');
  return _fileTypePromise;
}

function parseReadBy(val) {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Un JSON corrupto en un solo comentario no debe tirar abajo con 500 el listado completo.
function safeJsonParse(val) {
  if (!val) return null;
  try { return JSON.parse(val); } catch { return null; }
}

const app = express();
// Render (y Railway antes) ponen la app detrás de un único proxy reverso, que agrega el header
// X-Forwarded-For con la IP real del cliente. Sin esto, Express usa la IP del proxy para TODOS
// los requests — el rate-limiter de login (por IP) terminaría compartiendo un solo "balde" entre
// todos los usuarios en vez de limitar por persona.
app.set('trust proxy', 1);
const server = http.createServer(app);

// CORS: lista separada por comas (ej: "https://app.midominio.com,https://otro.com").
// Sin configurar, permite cualquier origen (comportamiento local por defecto).
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';
// DATABASE_URL solo se define en producción (Railway) — si llegó hasta acá sin CORS_ORIGIN,
// es fácil que haya quedado sin configurar por error, no a propósito.
if (process.env.DATABASE_URL && !process.env.CORS_ORIGIN) {
  console.warn('⚠️  CORS_ORIGIN no está configurado en producción — la API acepta requests de cualquier origen. Definí CORS_ORIGIN con la URL pública de la app.');
}

const io = new Server(server, {
  cors: { origin: corsOrigin, methods: ['GET', 'POST', 'PUT', 'DELETE'] }
});

if (!process.env.JWT_SECRET) {
  console.error('❌ JWT_SECRET no configurado. Definí la variable de entorno JWT_SECRET antes de iniciar el servidor.');
  process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 3001;

const uploadsDir = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Storage de archivos: Cloudflare R2 si hay credenciales configuradas (producción — Render no
// tiene disco persistente compartido entre instancias), si no cae a disco local (desarrollo),
// mismo patrón que ya usa `db` para elegir entre Postgres y SQLite según DATABASE_URL.
const R2_BUCKET = process.env.R2_BUCKET;
const r2VarNames = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
const r2VarsPresent = r2VarNames.filter(v => !!process.env[v]);
// Si falta UNA sola de las 4, es casi seguro un typo/olvido al configurar Render, no una decisión
// consciente de usar disco local — y con las 4 a medio configurar el server caía a disco local
// SIN avisar, que en Render es efímero: los archivos desaparecen en el próximo redeploy.
if (r2VarsPresent.length > 0 && r2VarsPresent.length < r2VarNames.length) {
  console.error(`❌ Configuración de R2 incompleta: definiste ${r2VarsPresent.join(', ')} pero faltan ${r2VarNames.filter(v => !process.env[v]).join(', ')}. Con la config a medias el server usaría disco local sin avisar (y en Render ese disco no persiste entre deploys). Completá las 4 variables o quitá todas para usar disco local a propósito.`);
  process.exit(1);
}
const useR2 = r2VarsPresent.length === r2VarNames.length;
if (process.env.DATABASE_URL && !useR2) {
  console.warn('⚠️  No hay credenciales de R2 configuradas en producción — los archivos subidos (videos, adjuntos) se guardan en disco local, que en Render NO persiste entre deploys y se pierde en cada reinicio.');
}
// requestChecksumCalculation/responseChecksumValidation en 'WHEN_REQUIRED': el default nuevo del
// SDK ('WHEN_SUPPORTED') agrega x-amz-checksum-mode a los GetObject y pide checksums en los
// PutObject/UploadPart. R2 no resuelve bien ese modo para objetos armados con multipart upload
// (los videos grandes, subidos en partes de 5MB) — la descarga se queda colgada sin traer nada,
// aunque el archivo esté íntegro en el bucket. Los archivos chicos del chat (un solo PUT) no
// pisaban este caso, por eso nunca se notó hasta un video de este tamaño.
const s3 = useR2 ? new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
}) : null;
console.log(useR2 ? `📦 Storage: Cloudflare R2 (bucket "${R2_BUCKET}")` : `📦 Storage: disco local (${uploadsDir})`);

// Sirve un archivo ya autorizado: redirige a una URL firmada de R2 (expira en 5 min, no hace
// falta que el bucket sea público) o lo sirve directo desde disco en desarrollo.
async function serveFile(res, filename) {
  if (useR2) {
    const url = await getSignedUrl(s3, new GetObjectCommand({ Bucket: R2_BUCKET, Key: filename }), { expiresIn: 300 });
    return res.redirect(url);
  }
  return res.sendFile(path.join(uploadsDir, filename));
}

// Borra un archivo subido sin tirar el request si falta o falla — se llama siempre después
// de que la DB ya quedó consistente, así que un error acá es solo una fuga de storage, no de datos.
async function safeUnlink(filename) {
  if (!filename) return;
  try {
    if (useR2) {
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
    } else {
      const filePath = path.join(uploadsDir, filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  } catch (e) { console.error('No se pudo borrar el archivo', filename, e.message); }
}

// La extensión del archivo en disco sale siempre del mimetype ya validado, nunca del nombre
// original (que el cliente controla) — evita subir un .html/.js disfrazado de un tipo permitido.
// Límite duro de disco: pasado este punto, se rechazan subidas nuevas con un error claro
// en vez de dejar que el disco se llene y las escrituras empiecen a fallar de forma críptica.
// Configurable vía STORAGE_LIMIT_GB (ej: tamaño del Volume de Railway); 25GB por defecto,
// un poco arriba del aviso de 20GB que ya reciben los admins.
const STORAGE_HARD_LIMIT_BYTES = (Number(process.env.STORAGE_LIMIT_GB) || 25) * 1024 * 1024 * 1024;

function makeUploader(mimeExtMap, { fileSize = 3 * 1024 * 1024 * 1024 } = {}) {
  // Con R2 no hay disco donde escribir directo desde multer — se recibe en memoria (el archivo
  // más grande de esta ruta compartida es un adjunto de chat/comentario, no un video, así que
  // buffear en RAM es razonable) y se sube a R2 recién después de verificar el contenido real.
  const storage = useR2 ? multer.memoryStorage() : multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => cb(null, `${uuidv4()}${mimeExtMap[file.mimetype] || ''}`)
  });
  return multer({
    storage,
    limits: { fileSize },
    fileFilter: async (req, file, cb) => {
      if (!mimeExtMap[file.mimetype]) return cb(new Error('INVALID_FILE_TYPE'));
      try {
        const bytes = await getUploadsSize();
        // El tamaño del archivo todavía no se conoce en este punto del streaming, así que
        // usamos Content-Length del request completo como cota superior — evita aceptar un
        // archivo grande cuando ya casi no queda margen contra el límite duro.
        const incomingBytes = Number(req.headers['content-length']) || 0;
        if (bytes + incomingBytes > STORAGE_HARD_LIMIT_BYTES) return cb(new Error('STORAGE_FULL'));
      } catch { /* si falla el chequeo de espacio, no bloqueamos la subida por eso */ }
      cb(null, true);
    }
  });
}

// Adjuntos de comentarios/respuestas y archivos de chat: mismo set de tipos seguros.
// Nota: no se permite image/svg+xml — un SVG puede embeber <script> y ejecutarlo si se abre directo.
const SAFE_ATTACHMENT_MIME_EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-msvideo': '.avi',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg', 'audio/webm': '.weba', 'audio/mp4': '.m4a',
  'application/pdf': '.pdf', 'text/plain': '.txt'
};
// Subida de video de proyecto: solo tipos de video reales (el frontend ya sugiere accept="video/*").
const VIDEO_MIME_EXT = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'video/x-msvideo': '.avi', 'video/x-matroska': '.mkv'
};
// El mimetype que usa multer para fijar la extensión sale del header Content-Type que manda
// el cliente en esa parte del multipart — no prueba nada sobre lo que realmente hay en el
// archivo. Esto lee los primeros bytes reales del archivo ya guardado y los compara contra
// la categoría declarada. text/plain no tiene firma binaria (cualquier byte es "texto plano"
// válido) así que no se puede verificar por contenido, pero tampoco hace falta: la extensión
// en disco queda forzada a .txt de todas formas y nunca se sirve con un Content-Type ejecutable.
async function verifyFileSignature(source, declaredMimetype) {
  if (declaredMimetype === 'text/plain') return true;
  const { fileTypeFromFile, fileTypeFromBuffer } = await getFileType();
  const detected = Buffer.isBuffer(source)
    ? await fileTypeFromBuffer(source).catch(() => null)
    : await fileTypeFromFile(source).catch(() => null);
  if (!detected) return false;
  if (declaredMimetype === 'application/pdf') return detected.mime === 'application/pdf';
  // WebM (audio y video) comparten el mismo contenedor Matroska/EBML — file-type no siempre
  // puede distinguir un WebM solo-audio (como el que graba MediaRecorder para notas de voz) de
  // uno con video, y termina reportando 'video/webm' aunque el archivo declarado sea de audio.
  // Es una limitación conocida del propio paquete, no una falla de seguridad real: ambos tipos
  // ya están permitidos en la whitelist, así que aceptar esta ambigüedad puntual no abre nada
  // que no estuviera ya abierto.
  if (declaredMimetype === 'audio/webm' && detected.mime === 'video/webm') return true;
  return detected.mime.split('/')[0] === declaredMimetype.split('/')[0];
}

// Verifica el contenido real de cada archivo de la tanda (son parte del mismo comentario/mensaje,
// se aceptan o rechazan juntos) y, si todos pasan, recién ahí los persiste. Con disco local ya
// están escritos por multer — si alguno falla, se borran. Con R2 todavía están solo en memoria
// (multer.memoryStorage) — si alguno falla no se subió nada; si todos pasan, se suben ahora y se
// les asigna `filename`, para que el resto del código no note la diferencia entre uno u otro backend.
async function verifyAndPersistFiles(files, mimeExtMap) {
  for (const f of files) {
    const source = useR2 ? f.buffer : f.path;
    if (!await verifyFileSignature(source, f.mimetype)) {
      if (!useR2) { for (const file of files) await fs.promises.unlink(file.path).catch(() => {}); }
      return false;
    }
  }
  if (useR2) {
    for (const f of files) {
      f.filename = `${uuidv4()}${mimeExtMap[f.mimetype] || ''}`;
      await s3.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: f.filename, Body: f.buffer, ContentType: f.mimetype }));
    }
  }
  return true;
}

// Thumbnail de video: se genera en el navegador de quien sube (un frame capturado a canvas,
// exportado como JPEG) — nunca hace falta procesar el video en el servidor.
const THUMBNAIL_MIME_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const thumbnailUpload = makeUploader(THUMBNAIL_MIME_EXT, { fileSize: 3 * 1024 * 1024 });

const attachmentUpload = makeUploader(SAFE_ATTACHMENT_MIME_EXT);
function attachmentUploadMiddleware(req, res, next) {
  attachmentUpload.array('attachments', 5)(req, res, async (err) => {
    if (err && err.message === 'INVALID_FILE_TYPE') return res.status(400).json({ error: 'Tipo de archivo no permitido en el adjunto.' });
    if (err && err.message === 'STORAGE_FULL') return res.status(507).json({ error: 'No hay espacio de almacenamiento disponible. Contactá al administrador.' });
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Archivo demasiado grande (máx. 3GB)' : (err.message || 'Error al subir archivo') });
    if (req.files?.length && !await verifyAndPersistFiles(req.files, SAFE_ATTACHMENT_MIME_EXT)) {
      return res.status(400).json({ error: 'El contenido de uno de los adjuntos no coincide con el tipo de archivo declarado.' });
    }
    next();
  });
}

// DB: usa Postgres si DATABASE_URL está definida (producción/Railway),
// si no cae a SQLite local (desarrollo) sin requerir configuración extra.
const db = process.env.DATABASE_URL
  ? knex({
      client: 'pg',
      connection: {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false
      },
      pool: { min: 0, max: 10 }
    })
  : knex({
      client: 'sqlite3',
      connection: { filename: path.join(__dirname, '../agencyos.db') },
      useNullAsDefault: true,
      // SQLite ignora las foreign keys por default en cada conexión nueva — sin este pragma, las
      // constraints de la migración 20260923075409 quedan declaradas pero nunca se aplican acá
      // (sí se aplican solas en Postgres/producción), y un bug de integridad pasaría inadvertido
      // en dev/tests aunque en producción sí tirara error.
      pool: { afterCreate: (conn, cb) => conn.run('PRAGMA foreign_keys = ON', cb) }
    });

// Poblar project_members a partir de datos existentes (se ejecuta una sola vez al crear la tabla).
async function seedProjectMembers() {
  const projects = await db('projects').select('id', 'created_by', 'payment_editor_id');
  const seen = new Set();
  const rows = [];

  function add(projectId, userId, role) {
    if (!projectId || !userId) return;
    const key = `${projectId}:${userId}`;
    if (seen.has(key)) return;
    seen.add(key);
    rows.push({ project_id: projectId, user_id: userId, role });
  }

  for (const p of projects) {
    add(p.id, p.created_by, 'owner');
    add(p.id, p.payment_editor_id, 'member');
  }

  const tasks = await db('tasks').select('project_id', 'assigned_to');
  for (const t of tasks) add(t.project_id, t.assigned_to, 'member');

  const videos = await db('videos').select('project_id', 'uploaded_by');
  for (const v of videos) add(v.project_id, v.uploaded_by, 'member');

  const messages = await db('messages').where({ type: 'project' }).select('project_id', 'sender_id');
  for (const m of messages) add(m.project_id, m.sender_id, 'member');

  const comments = await db('video_comments as vc')
    .join('videos as v', 'vc.video_id', 'v.id')
    .select('v.project_id', 'vc.user_id');
  for (const c of comments) add(c.project_id, c.user_id, 'member');

  const replies = await db('comment_replies as cr')
    .join('video_comments as vc', 'cr.comment_id', 'vc.id')
    .join('videos as v', 'vc.video_id', 'v.id')
    .select('v.project_id', 'cr.user_id');
  for (const r of replies) add(r.project_id, r.user_id, 'member');

  if (rows.length > 0) await db('project_members').insert(rows);
}

// Misma paleta que AVATAR_COLORS en client/src/pages/Team.jsx (el selector manual de color al
// editar un usuario) — si se agregan colores acá, agregarlos también ahí para que coincidan.
const AVATAR_COLORS = ['#6366f1','#ec4899','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ef4444','#14b8a6','#f97316','#06b6d4'];
// Devuelve un color de la paleta que ningún usuario esté usando todavía. Si ya se usaron los 10
// (más de 10 personas en el equipo), genera uno nuevo por rotación de tono (HSL) que sigue siendo
// distinto de cualquier color de la paleta o generado previamente.
function pickUnusedAvatarColor(usedColors) {
  const free = AVATAR_COLORS.find(c => !usedColors.has(c));
  if (free) return free;
  let hue = 0;
  let color;
  do {
    color = `hsl(${hue}, 65%, 55%)`;
    hue = (hue + 137) % 360;
  } while (usedColors.has(color));
  return color;
}

async function initDB() {
  const hasUsers = await db.schema.hasTable('users');
  if (!hasUsers) {
    await db.schema.createTable('users', t => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('email').unique().notNullable();
      t.string('password').notNullable();
      t.string('role').defaultTo('editor');
      t.string('avatar_color').defaultTo('#6366f1');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasProjects = await db.schema.hasTable('projects');
  if (!hasProjects) {
    await db.schema.createTable('projects', t => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('description');
      t.string('status').defaultTo('active');
      t.string('color').defaultTo('#6366f1');
      t.string('created_by');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasTasks = await db.schema.hasTable('tasks');
  if (!hasTasks) {
    await db.schema.createTable('tasks', t => {
      t.string('id').primary();
      t.string('project_id').notNullable();
      t.string('title').notNullable();
      t.string('description');
      t.string('status').defaultTo('todo');
      t.string('priority').defaultTo('medium');
      t.string('assigned_to');
      t.string('created_by');
      t.string('due_date');
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.timestamp('updated_at').defaultTo(db.fn.now());
    });
  }
  const hasMessages = await db.schema.hasTable('messages');
  if (!hasMessages) {
    await db.schema.createTable('messages', t => {
      t.string('id').primary();
      t.string('project_id');
      t.string('sender_id').notNullable();
      t.string('receiver_id');
      t.text('content').notNullable();
      t.string('type').defaultTo('project');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasVideos = await db.schema.hasTable('videos');
  if (!hasVideos) {
    await db.schema.createTable('videos', t => {
      t.string('id').primary();
      t.string('project_id').notNullable();
      t.string('title').notNullable();
      t.string('filename').notNullable();
      t.string('original_name').notNullable();
      t.integer('version').defaultTo(1);
      t.string('uploaded_by');
      t.integer('file_size');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasComments = await db.schema.hasTable('video_comments');
  if (!hasComments) {
    await db.schema.createTable('video_comments', t => {
      t.string('id').primary();
      t.string('video_id').notNullable();
      t.string('user_id').notNullable();
      t.text('content').notNullable();
      t.float('timestamp_sec').defaultTo(0);
      t.text('annotation');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasAttachments = await db.schema.hasTable('comment_attachments');
  if (!hasAttachments) {
    await db.schema.createTable('comment_attachments', t => {
      t.string('id').primary();
      t.string('comment_id').notNullable();
      t.string('filename').notNullable();
      t.string('original_name').notNullable();
    });
  }

  const hasChatMessages = await db.schema.hasTable('chat_messages');
  if (!hasChatMessages) {
    await db.schema.createTable('chat_messages', t => {
      t.string('id').primary();
      t.string('sender_id').notNullable();
      t.string('receiver_id'); // for DMs
      t.string('channel_id'); // for channels
      t.string('type').notNullable(); // 'dm' | 'channel'
      t.text('content').defaultTo('');
      t.string('file_url');
      t.string('file_type'); // 'image' | 'video' | 'audio' | 'file'
      t.string('file_name');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasChatChannels = await db.schema.hasTable('chat_channels');
  if (!hasChatChannels) {
    await db.schema.createTable('chat_channels', t => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('created_by').notNullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasChatMembers = await db.schema.hasTable('chat_channel_members');
  if (!hasChatMembers) {
    await db.schema.createTable('chat_channel_members', t => {
      t.string('channel_id').notNullable();
      t.string('user_id').notNullable();
    });
  }
  const hasTimestampEnd = await db.schema.hasColumn('video_comments', 'timestamp_end');
  if (!hasTimestampEnd) {
    await db.schema.table('video_comments', t => { t.float('timestamp_end').nullable(); });
  }
  const hasResolved = await db.schema.hasColumn('video_comments', 'resolved');
  if (!hasResolved) {
    await db.schema.table('video_comments', t => { t.boolean('resolved').defaultTo(false); });
  }
  // Comentarios de un invitado externo (link de revisión para clientes, ver video_shares más
  // abajo) — no tienen user_id porque quien comenta no tiene cuenta. user_id era NOT NULL desde
  // que se creó la tabla; ya se aflojó a nullable hace tiempo (confirmado en el schema real) y no
  // hace falta reintentarlo en cada boot. El propio intento de re-aflojarla vía .alter() (que en
  // SQLite reconstruye la tabla entera) empezó a fallar con "FOREIGN KEY constraint failed" desde
  // que esta tabla tiene FKs reales (ver la migración de foreign keys) — inofensivo porque ya
  // estaba en el estado correcto, pero seguía imprimiendo un warning en cada arranque para siempre.
  const hasGuestName = await db.schema.hasColumn('video_comments', 'guest_name');
  if (!hasGuestName) {
    await db.schema.table('video_comments', t => { t.string('guest_name').nullable(); });
  }
  const hasShares = await db.schema.hasTable('video_shares');
  if (!hasShares) {
    await db.schema.createTable('video_shares', t => {
      t.string('id').primary(); // el id ES el token público, va directo en la URL /review/:id
      t.string('video_id').notNullable();
      t.string('created_by').notNullable();
      t.timestamp('expires_at'); // null = sin vencimiento (no se ofrece desde la UI, pero el
                                  // campo lo soporta por si algún día se necesita)
      t.boolean('revoked').defaultTo(false);
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasReplies = await db.schema.hasTable('comment_replies');
  if (!hasReplies) {
    await db.schema.createTable('comment_replies', t => {
      t.string('id').primary();
      t.string('comment_id').notNullable();
      t.string('user_id').notNullable();
      t.text('content').notNullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  const hasReplyAttachments = await db.schema.hasTable('reply_attachments');
  if (!hasReplyAttachments) {
    await db.schema.createTable('reply_attachments', t => {
      t.string('id').primary();
      t.string('reply_id').notNullable();
      t.string('filename').notNullable();
      t.string('original_name').notNullable();
    });
  }

  const hasNotifications = await db.schema.hasTable('notifications');
  if (!hasNotifications) {
    await db.schema.createTable('notifications', t => {
      t.string('id').primary();
      t.string('user_id').notNullable();        // who receives it
      t.string('type').notNullable();           // 'comment' | 'reply' | 'chat'
      t.string('actor_id').notNullable();       // who triggered it
      t.string('project_id');
      t.string('video_id');
      t.string('comment_id');
      t.string('chat_message_id');
      t.text('preview');                        // short text preview
      t.boolean('read').defaultTo(false);
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }
  // Un comentario de un invitado externo (link de revisión para clientes) dispara notificaciones
  // sin un actor humano en `users` — actor_id era NOT NULL y todas las lecturas usaban INNER JOIN
  // contra users, así que esas notificaciones directamente desaparecían de la lista (el INNER
  // JOIN las filtra) en vez de solo faltarles el nombre. Mismo tratamiento (y mismo motivo para
  // ya no reintentar el .alter() en cada boot) que video_comments.user_id, ver el comentario ahí.
  const hasNotifGuestName = await db.schema.hasColumn('notifications', 'guest_name');
  if (!hasNotifGuestName) {
    await db.schema.table('notifications', t => { t.string('guest_name').nullable(); });
  }
  const hasMsgRead = await db.schema.hasColumn('chat_messages', 'read_by');
  if (!hasMsgRead) {
    await db.schema.table('chat_messages', t => { t.text('read_by').defaultTo('[]'); });
  }

  const hasChatClientId = await db.schema.hasColumn('chat_messages', 'client_id');
  if (!hasChatClientId) {
    await db.schema.table('chat_messages', t => { t.string('client_id').nullable(); });
  }

  // Duración real (segundos) de notas de voz, tomada del cronómetro del cliente al grabar —
  // los .webm de MediaRecorder no siempre reportan su propia duración de forma confiable, así
  // que en vez de depender del navegador para mostrarla se guarda el valor ya conocido.
  const hasFileDuration = await db.schema.hasColumn('chat_messages', 'file_duration');
  if (!hasFileDuration) {
    await db.schema.table('chat_messages', t => { t.integer('file_duration').nullable(); });
  }

  const hasPaymentType = await db.schema.hasColumn('projects', 'payment_type');
  if (!hasPaymentType) {
    await db.schema.table('projects', t => {
      t.string('payment_editor_id');
      t.string('payment_type').defaultTo('fixed');
      t.float('payment_amount').defaultTo(0);
      t.float('payment_hours').defaultTo(0);
      t.string('payment_status').defaultTo('unpaid');
      t.string('upwork_status').defaultTo('pending');
    });
  }

  const hasClientAmount = await db.schema.hasColumn('projects', 'client_amount');
  if (!hasClientAmount) {
    await db.schema.table('projects', t => { t.float('client_amount').defaultTo(0); });
  }

  // % que Upwork descuenta del cobro al cliente en los proyectos facturados por esa plataforma
  // (upwork_status ya existía para trackear si las horas del período se cargaron o no; esto es
  // lo que hace falta además para calcular cuánto llega realmente neto).
  const hasUpworkFeePct = await db.schema.hasColumn('projects', 'upwork_fee_pct');
  if (!hasUpworkFeePct) {
    await db.schema.table('projects', t => { t.float('upwork_fee_pct').nullable(); });
  }

  // Montos "congelados" al momento exacto de marcar pagado/cobrado — en un proyecto por horas,
  // las horas se siguen editando en Pagos incluso después de marcarlo pagado (corrección de un
  // error, etc.); sin esto, el monto de un mes ya cerrado en el Balance mensual cambiaba solo
  // porque alguien tocó las horas de ese proyecto meses después.
  const hasPaidAmounts = await db.schema.hasColumn('projects', 'editor_paid_amount');
  if (!hasPaidAmounts) {
    await db.schema.table('projects', t => {
      t.float('editor_paid_amount').nullable();
      t.float('client_paid_amount_gross').nullable();
      t.float('client_paid_amount_net').nullable();
    });
  }

  const hasCompletedAt = await db.schema.hasColumn('projects', 'completed_at');
  if (!hasCompletedAt) {
    await db.schema.table('projects', t => { t.timestamp('completed_at').nullable(); });
  }

  // Fecha exacta en que se marcó pagado/cobrado cada lado — completed_at (arriba) solo se
  // completa cuando AMBOS lados quedan saldados, no sirve para saber en qué mes se cobró el
  // cliente si el editor se pagó en un mes distinto. Necesario para el balance mensual de Pagos.
  const hasEditorPaidAt = await db.schema.hasColumn('projects', 'editor_paid_at');
  if (!hasEditorPaidAt) {
    await db.schema.table('projects', t => {
      t.timestamp('editor_paid_at').nullable();
      t.timestamp('client_paid_at').nullable();
    });
  }

  // Si se marca "cliente ya pagó" (o "editor pagado") en un proyecto que todavía está activo —
  // ej. un anticipo antes de terminar el trabajo — eso NO debería alcanzar para que aparezca en
  // Pagos: esa sección es específicamente para proyectos ya marcados "terminado". ever_completed
  // guarda que el proyecto llegó a estar terminado alguna vez, y una vez en true nunca se vuelve a
  // false — así, si después se reabre para un retoque, Pagos/Balance mensual no pierden el
  // historial de lo que ya se pagó/cobró (ese sí era el bug real a resolver).
  const hasEverCompleted = await db.schema.hasColumn('projects', 'ever_completed');
  if (!hasEverCompleted) {
    await db.schema.table('projects', t => { t.boolean('ever_completed').defaultTo(false); });
    await db('projects').where({ status: 'completed' }).update({ ever_completed: true });
  }

  // Link de referencia (drive, footage crudo, brief, etc.) — es info de trabajo, no de plata, así
  // que la ven todos los miembros del proyecto (no va en PROJECT_FINANCIAL_FIELDS).
  const hasMaterialLink = await db.schema.hasColumn('projects', 'material_link');
  if (!hasMaterialLink) {
    await db.schema.table('projects', t => { t.string('material_link').nullable(); });
  }

  // Clients table
  const hasClients = await db.schema.hasTable('clients');
  if (!hasClients) {
    await db.schema.createTable('clients', t => {
      t.string('id').primary();
      t.string('name').notNullable();
      t.string('color').defaultTo('#6366f1');
      t.string('email');
      t.string('phone');
      t.text('notes');
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  // Add client_id and deadline to projects
  const hasClientId = await db.schema.hasColumn('projects', 'client_id');
  if (!hasClientId) {
    await db.schema.table('projects', t => {
      t.string('client_id').nullable();
      t.date('deadline').nullable();
    });
  }

  // Add separate editor/client payment status
  const hasEditorPaid = await db.schema.hasColumn('projects', 'editor_paid');
  if (!hasEditorPaid) {
    await db.schema.table('projects', t => {
      t.string('editor_paid').defaultTo('unpaid');   // unpaid | paid
      t.string('client_paid').defaultTo('unpaid');   // unpaid | cobrado
    });
  }

  const hasVideoTaskId = await db.schema.hasColumn('videos', 'task_id');
  if (!hasVideoTaskId) {
    await db.schema.table('videos', t => { t.string('task_id').nullable(); });
  }
  const hasVideoGroupId = await db.schema.hasColumn('videos', 'group_id');
  if (!hasVideoGroupId) {
    await db.schema.table('videos', t => { t.string('group_id').nullable(); });
  }
  // Antes toda card de video en la grilla mostraba el mismo emoji ▶️ sobre un cuadro gris —
  // imposible distinguir un video de otro sin abrirlo. El frame se captura en el navegador de
  // quien sube (ver POST /api/videos/:id/thumbnail), no hace falta ffmpeg en el servidor.
  const hasVideoThumb = await db.schema.hasColumn('videos', 'thumbnail_filename');
  if (!hasVideoThumb) {
    await db.schema.table('videos', t => { t.string('thumbnail_filename').nullable(); });
  }
  // "Aprobado" era solo un estado inferido (sin comentarios sin resolver) — no había ninguna
  // acción real de aprobar, así que un video se mostraba aprobado por descarte, no porque alguien
  // lo hubiera decidido. approved_by es nullable porque lo puede aprobar un usuario interno O un
  // cliente sin cuenta desde el link público (approved_by_guest_name, mismo patrón que guest_name
  // en video_comments) — nunca los dos a la vez.
  const hasVideoApproved = await db.schema.hasColumn('videos', 'approved_at');
  if (!hasVideoApproved) {
    await db.schema.table('videos', t => {
      t.datetime('approved_at').nullable();
      t.string('approved_by').nullable();
      t.string('approved_by_guest_name').nullable();
    });
  }

  // Tabla de miembros de proyecto: controla qué usuarios tienen acceso a qué proyectos.
  const hasProjectMembers = await db.schema.hasTable('project_members');
  if (!hasProjectMembers) {
    await db.schema.createTable('project_members', t => {
      t.string('project_id').notNullable();
      t.string('user_id').notNullable();
      t.string('role').defaultTo('member'); // 'owner' | 'member'
      t.timestamp('added_at').defaultTo(db.fn.now());
      t.unique(['project_id', 'user_id']);
    });
    await seedProjectMembers();
  }

  // Silenciar notificaciones de un proyecto puntual — antes la única forma de "no recibir más
  // avisos de esto" era ignorarlos a mano cada vez, sin ninguna forma real de bajarle el volumen
  // a un proyecto específico que ya no necesita seguimiento activo.
  const hasNotificationMutes = await db.schema.hasTable('notification_mutes');
  if (!hasNotificationMutes) {
    await db.schema.createTable('notification_mutes', t => {
      t.string('id').primary();
      t.string('user_id').notNullable();
      t.string('project_id').notNullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
      t.unique(['user_id', 'project_id']);
    });
  }

  // Eventos propios del calendario (rodaje, reunión, recordatorio) — antes el calendario solo
  // podía mostrar deadlines de proyecto, nada que no viniera ya de otro lado. Son del equipo
  // entero (cualquiera los ve y crea), no algo privado por usuario.
  const hasCalendarEvents = await db.schema.hasTable('calendar_events');
  if (!hasCalendarEvents) {
    await db.schema.createTable('calendar_events', t => {
      t.string('id').primary();
      t.string('title').notNullable();
      t.string('date').notNullable(); // YYYY-MM-DD, mismo formato que projects.deadline
      t.string('color').notNullable();
      t.string('created_by').notNullable();
      t.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  // Token secreto por usuario para el feed .ics — es la única forma de "loguearse" que entiende
  // una app de calendario externa (Google/Apple Calendar solo pueden pegar una URL, no loguearse
  // con usuario/contraseña). Se genera la primera vez que se pide el link, no de entrada para
  // todos los usuarios que capaz nunca lo usan.
  const hasCalendarFeedToken = await db.schema.hasColumn('users', 'calendar_feed_token');
  if (!hasCalendarFeedToken) {
    await db.schema.table('users', t => { t.string('calendar_feed_token').nullable().unique(); });
  }

  // Orden manual (drag & drop) de clientes y proyectos en el sidebar. Al agregar la columna se
  // hace un backfill único con el orden que ya se veía (alfabético para clientes, más reciente
  // primero para proyectos dentro de cada cliente) para no pegarle un salto visual a nadie.
  const hasClientSortOrder = await db.schema.hasColumn('clients', 'sort_order');
  if (!hasClientSortOrder) {
    await db.schema.table('clients', t => { t.integer('sort_order').nullable(); });
    const existingClients = await db('clients').orderBy('name', 'asc').select('id');
    for (let i = 0; i < existingClients.length; i++) {
      await db('clients').where({ id: existingClients[i].id }).update({ sort_order: i });
    }
  }
  const hasProjectSortOrder = await db.schema.hasColumn('projects', 'sort_order');
  if (!hasProjectSortOrder) {
    await db.schema.table('projects', t => { t.integer('sort_order').nullable(); });
    const allProjects = await db('projects').orderBy('created_at', 'desc').select('id', 'client_id');
    const byClient = {};
    for (const p of allProjects) {
      const key = p.client_id || '__none__';
      (byClient[key] = byClient[key] || []).push(p.id);
    }
    for (const ids of Object.values(byClient)) {
      for (let i = 0; i < ids.length; i++) {
        await db('projects').where({ id: ids[i] }).update({ sort_order: i });
      }
    }
  }

  // Seed admin: solo si NINGÚN admin existe todavía, no si falta ese email puntual — antes
  // buscaba por el email exacto 'admin@agencyos.com', así que una vez que ese usuario cambiaba
  // de email (ej: consolidar la cuenta seed con la cuenta real de alguien) este chequeo volvía
  // a dar "no existe" en cada reinicio del server y recreaba un admin fantasma cada vez.
  const anyAdmin = await db('users').where({ role: 'admin' }).first();
  if (!anyAdmin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db('users').insert({ id: uuidv4(), name: 'Admin', email: 'admin@agencyos.com', password: hash, role: 'admin', avatar_color: '#f59e0b' });
    console.log('✅ Admin creado: admin@agencyos.com / admin123');
  }

  // El color de avatar se elegía al azar sin chequear contra los ya usados, así que dos personas
  // podían terminar con el mismo color (pasó con dos integrantes reales del equipo). Se corre en
  // cada arranque del server: no hace nada si ya no hay duplicados, así que es seguro repetirlo.
  const allUsers = await db('users').orderBy('created_at', 'asc').select('id', 'avatar_color');
  const usedColors = new Set();
  for (const u of allUsers) {
    if (u.avatar_color && !usedColors.has(u.avatar_color)) {
      usedColors.add(u.avatar_color);
    } else {
      const newColor = pickUnusedAvatarColor(usedColors);
      usedColors.add(newColor);
      await db('users').where({ id: u.id }).update({ avatar_color: newColor });
    }
  }

  // Índices sobre las columnas que se filtran/joinean todo el tiempo (project_id, user_id, etc.) —
  // no había ninguno declarado más allá de las PK y el unique de project_members, así que cada
  // query de esas se resuelve con un full scan. Con el volumen de hoy no se nota, pero es gratis
  // agregarlo ahora que arreglar una consulta lenta más adelante. `IF NOT EXISTS` es válido tanto
  // en Postgres como en SQLite, así que es seguro correr esto en cada arranque.
  const indexes = [
    ['idx_tasks_project_id', 'tasks', 'project_id'],
    ['idx_tasks_assigned_to', 'tasks', 'assigned_to'],
    ['idx_messages_project_id', 'messages', 'project_id'],
    ['idx_videos_project_id', 'videos', 'project_id'],
    ['idx_video_comments_video_id', 'video_comments', 'video_id'],
    ['idx_comment_attachments_comment_id', 'comment_attachments', 'comment_id'],
    ['idx_chat_messages_sender_id', 'chat_messages', 'sender_id'],
    ['idx_chat_messages_receiver_id', 'chat_messages', 'receiver_id'],
    ['idx_chat_messages_channel_id', 'chat_messages', 'channel_id'],
    ['idx_chat_channel_members_channel_id', 'chat_channel_members', 'channel_id'],
    ['idx_chat_channel_members_user_id', 'chat_channel_members', 'user_id'],
    ['idx_comment_replies_comment_id', 'comment_replies', 'comment_id'],
    ['idx_reply_attachments_reply_id', 'reply_attachments', 'reply_id'],
    ['idx_notifications_user_id', 'notifications', 'user_id'],
    ['idx_notifications_project_id', 'notifications', 'project_id'],
    ['idx_projects_client_id', 'projects', 'client_id'],
    ['idx_projects_payment_editor_id', 'projects', 'payment_editor_id'],
    ['idx_project_members_user_id', 'project_members', 'user_id'],
  ];
  for (const [indexName, table, column] of indexes) {
    await db.raw(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} (${column})`);
  }

  // Todo lo de arriba es el patrón viejo (~35 bloques `hasColumn`/`hasTable` acumulados con el
  // tiempo) — se deja tal cual, sin tocar, porque ya funciona y es idempotente. De acá en
  // adelante, cualquier cambio de esquema NUEVO va como una migración de knex versionada (carpeta
  // migrations/, se crea con `npx knex migrate:make nombre_del_cambio`) en vez de otro bloque
  // inline — con 35 ya acumulados, cada arranque hacía esa cantidad de queries de introspección
  // solo para decidir si migrar, y no quedaba ningún historial ni forma de hacer rollback. knex
  // guarda su propia tabla de control (knex_migrations) así que esto es seguro de correr en cada
  // arranque: si no hay migraciones nuevas pendientes, no hace nada.
  await db.migrate.latest({ directory: path.join(__dirname, '../migrations') });
}

// Headers de seguridad HTTP. CSP explícita (useDefaults: false) en vez de confiar en la
// default de helmet, porque esta app necesita permisos puntuales que esa default no da:
// Google Fonts (stylesheet + archivos de fuente) y estilos inline (toda la UI usa style={{...}}
// en vez de CSS modules, así que style-src necesita 'unsafe-inline'; no hay <script> inline en
// ningún lado, así que script-src se mantiene estricto). crossOriginEmbedderPolicy se apaga:
// esta app no usa SharedArrayBuffer/WASM threads que necesiten aislamiento cross-origin, y
// dejarlo prendido arriesga romper la carga de Google Fonts sin ningún beneficio real acá.
// Con R2, /uploads/:filename redirige (302) a una signed URL en <bucket>.<account>.r2.cloudflarestorage.com
// — la CSP se evalúa sobre la URL final después del redirect, no la original, así que ese origen
// tiene que estar permitido en img-src/media-src o el navegador bloquea la carga en silencio
// (esto rompió imágenes/audio/video del chat la primera vez que se probó con contenido real).
const r2Origin = useR2 ? `https://${R2_BUCKET}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : null;
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', ...(r2Origin ? [r2Origin] : [])],
      // 'blob:' hace falta para el preview de notas de voz (audio.src = URL.createObjectURL(blob),
      // local al navegador, antes de subir nada) — mismo tipo de gap que ya se corrigió en img-src.
      mediaSrc: ["'self'", 'blob:', ...(r2Origin ? [r2Origin] : [])],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));
app.use(cors({ origin: corsOrigin }));
app.use(express.json());

// El token viaja SIEMPRE por header Authorization en esta ruta — el query string ?token=... se
// sacó de acá (ver authMedia más abajo): antes cualquier endpoint autenticado, no solo /uploads,
// aceptaba el token de sesión completo de 7 días como parámetro de URL, y esa es exactamente la
// forma en que termina en el historial del navegador y en cualquier log que registre URLs enteras.
// El rol se revalida contra la DB en cada request (no se confía en el rol embebido en el token):
// si el admin fue degradado o borrado después de emitido el token, no debe seguir actuando como admin.
const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sesión no iniciada' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
  // Un token de media (ver authMedia) es de corta duración y solo debería viajar por query string
  // hacia /uploads — si alguien lo manda acá por header (a mano, o por un bug de otro lado), no
  // debe abrir el resto de la API igual que un token de sesión completo.
  if (decoded.scope === 'media') return res.status(401).json({ error: 'Token inválido' });
  // El fallo de la query va aparte a propósito: si se devuelve 401 ante un corte transitorio de
  // la DB, el cliente lo interpreta como sesión vencida y desloguea a todo el equipo de una.
  try {
    const current = await db('users').where({ id: decoded.id }).select('id', 'email', 'role').first();
    if (!current) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.user = current;
    next();
  } catch (e) {
    console.error('auth:', e);
    res.status(503).json({ error: 'Servicio no disponible, reintentá en unos segundos' });
  }
};

// Middleware exclusivo de /uploads/:filename. El <img>/<video>/<audio src> no puede mandar el
// header Authorization, así que necesita ir por query string — pero ya no con el token de sesión
// de 7 días (ver el comentario de `auth` arriba). Este exige específicamente un token de media de
// corta duración (emitido por GET /api/media-token), que si se filtra por historial del navegador
// o por un log de acceso no sirve para nada más que ver archivos por un rato corto.
const authMedia = async (req, res, next) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: 'Sesión no iniciada' });
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch { return res.status(401).json({ error: 'Token inválido' }); }
  if (decoded.scope !== 'media') return res.status(401).json({ error: 'Token inválido' });
  try {
    const current = await db('users').where({ id: decoded.id }).select('id', 'email', 'role').first();
    if (!current) return res.status(401).json({ error: 'Usuario no encontrado' });
    req.user = current;
    next();
  } catch (e) {
    console.error('authMedia:', e);
    res.status(503).json({ error: 'Servicio no disponible, reintentá en unos segundos' });
  }
};

// Sirve archivos subidos (videos, adjuntos de comentarios/chat) solo a usuarios autenticados
// que tengan acceso real al proyecto o conversación dueña del archivo. Reemplaza el static()
// público anterior, que permitía descargar cualquier archivo sabiendo su nombre.
app.get('/uploads/:filename', authMedia, async (req, res) => {
  try {
    const { filename } = req.params;
    if (!filename || filename.includes('..') || filename.includes('/')) {
      return res.status(400).json({ error: 'Nombre de archivo inválido' });
    }
    // Con disco local se puede chequear existencia antes de gastar queries; con R2 no vale la pena
    // el viaje extra (HeadObject) — si no existe, el redirect a la signed URL simplemente 404ea.
    if (!useR2 && !fs.existsSync(path.join(uploadsDir, filename))) {
      return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    if (req.user.role === 'admin') return serveFile(res, filename);

    // El thumbnail tiene su propio nombre de archivo (distinto al del video), así que el mismo
    // chequeo de acceso por proyecto tiene que poder encontrar el video dueño buscando por
    // cualquiera de las dos columnas.
    const video = await db('videos').where({ filename }).orWhere({ thumbnail_filename: filename }).first();
    if (video) {
      if (await isProjectMember(req.user.id, req.user.role, video.project_id)) return serveFile(res, filename);
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const commentAttachment = await db('comment_attachments as ca')
      .join('video_comments as vc', 'ca.comment_id', 'vc.id')
      .join('videos as v', 'vc.video_id', 'v.id')
      .where('ca.filename', filename)
      .select('v.project_id')
      .first();
    if (commentAttachment) {
      if (await isProjectMember(req.user.id, req.user.role, commentAttachment.project_id)) return serveFile(res, filename);
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const replyAttachment = await db('reply_attachments as ra')
      .join('comment_replies as cr', 'ra.reply_id', 'cr.id')
      .join('video_comments as vc', 'cr.comment_id', 'vc.id')
      .join('videos as v', 'vc.video_id', 'v.id')
      .where('ra.filename', filename)
      .select('v.project_id')
      .first();
    if (replyAttachment) {
      if (await isProjectMember(req.user.id, req.user.role, replyAttachment.project_id)) return serveFile(res, filename);
      return res.status(403).json({ error: 'Sin acceso' });
    }

    const chatMsg = await db('chat_messages').where({ file_url: `/uploads/${filename}` }).first();
    if (chatMsg) {
      if (chatMsg.sender_id === req.user.id || chatMsg.receiver_id === req.user.id) return serveFile(res, filename);
      if (chatMsg.channel_id) {
        const member = await db('chat_channel_members').where({ channel_id: chatMsg.channel_id, user_id: req.user.id }).first();
        if (member) return serveFile(res, filename);
      }
      return res.status(403).json({ error: 'Sin acceso' });
    }

    return res.status(404).json({ error: 'Archivo no encontrado' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── CÁLCULO DE MONTOS DE PAGO ─────────────────────────────────────────────────
// Funciones puras (sin DB ni HTTP) — viven en lib/payments.js para poder testearlas sin levantar
// todo el servidor. Ver ese archivo para el detalle de cada una.
const {
  OWNER_EMAIL,
  parseUpworkFeePct,
  computeEditorAmount,
  computeClientGrossAmount,
  computeClientNetAmount,
  withComputedTotals,
} = require('./lib/payments');

// ─── PROJECT MEMBERSHIP ───────────────────────────────────────────────────────
const {
  isProjectMember, addProjectMember, removeProjectMemberIfOrphaned,
  TASK_STATUSES, stripProjectFinancials, withDeletedEditorFallback,
  emitToProject, requireProjectAccess, loginLimiter, uploadLimiter,
} = require('./lib/project-access')({ db, io });

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.use(require('./routes/auth')({ db, auth, loginLimiter, bcrypt, jwt, JWT_SECRET, pickUnusedAvatarColor, safeUnlink }));

// ─── PROJECTS ────────────────────────────────────────────────────────────────
app.use(require('./routes/projects')({ db, auth, io, requireProjectAccess, withDeletedEditorFallback, withComputedTotals, stripProjectFinancials, addProjectMember, emitToProject, createNotification, parseUpworkFeePct, removeProjectMemberIfOrphaned, OWNER_EMAIL, safeUnlink }));

// ─── PROJECT MEMBERS CRUD ───────────────────────────────────────────────────
// Extraído a routes/project-members.js.
app.use(require('./routes/project-members')({ db, auth, io, requireProjectAccess, addProjectMember }));

// ─── CLIENTS ─────────────────────────────────────────────────────────────────
// Extraído a routes/clients.js.
app.use(require('./routes/clients')({ db, auth, io }));

// ─── SEARCH ──────────────────────────────────────────────────────────────────
// Extraído a routes/search.js (ver ese archivo para el detalle) — primera sección movida fuera
// de este archivo hacia una estructura de rutas separadas.
app.use(require('./routes/search')({ db, auth }));

// ─── DASHBOARD ──────────────────────────────────────────────────────────────
// Extraído a routes/dashboard.js.
app.use(require('./routes/dashboard')({ db, auth }));

// ─── CALENDAR ────────────────────────────────────────────────────────────────
// Extraído a routes/calendar.js.
app.use(require('./routes/calendar')({ db, auth }));

// ─── EDITOR DETAIL (admin only) ─────────────────────────────────────────────
// Extraído a routes/earnings.js.
app.use(require('./routes/earnings')({ db, auth, computeEditorAmount }));

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
app.use(require('./routes/payments')({ db, auth, io, withDeletedEditorFallback, withComputedTotals, computeEditorAmount, computeClientGrossAmount, computeClientNetAmount, OWNER_EMAIL }));

// ─── TASKS ───────────────────────────────────────────────────────────────────
app.use(require('./routes/tasks')({ db, auth, requireProjectAccess, isProjectMember, addProjectMember, removeProjectMemberIfOrphaned, emitToProject, createNotification, TASK_STATUSES }));

// ─── MESSAGES ────────────────────────────────────────────────────────────────
// Extraído a routes/messages.js.
app.use(require('./routes/messages')({ db, auth, requireProjectAccess }));

// ─── VIDEOS ──────────────────────────────────────────────────────────────────
app.use(require('./routes/videos')({ db, auth, requireProjectAccess, thumbnailUpload, isProjectMember, verifyAndPersistFiles, THUMBNAIL_MIME_EXT, emitToProject }));

// ─── SUBIDA DE VIDEO POR PARTES ──────────────────────────────────────────────
// (Sesiones de subida, escaneo de storage y limpieza de huérfanos viven en lib/storage.js;
// las rutas de subida/aprobación/stack/storage viven en routes/video-upload.js.)
const {
  CHUNK_SIZE, VIDEO_MAX_BYTES, chunksDir, uploadSessions, discardUploadSession,
  getUploadsSize, STORAGE_WARN_BYTES,
} = require('./lib/storage')({ db, useR2, s3, R2_BUCKET, uploadsDir });
app.use(require('./routes/video-upload')({
  db, auth, io, requireProjectAccess, uploadLimiter, isProjectMember, emitToProject, createNotification, safeUnlink,
  useR2, s3, R2_BUCKET, uploadsDir, VIDEO_MIME_EXT, verifyFileSignature, STORAGE_HARD_LIMIT_BYTES,
  CHUNK_SIZE, VIDEO_MAX_BYTES, chunksDir, uploadSessions, discardUploadSession, getUploadsSize, STORAGE_WARN_BYTES,
}));
require('./lib/review-reminders')({ db, createNotification });

// ─── STORAGE CHECK ───────────────────────────────────────────────────────────
// (GET /api/storage está en routes/video-upload.js; el resto de esta sección se movió a lib/storage.js.)

// ─── VIDEO COMMENTS ──────────────────────────────────────────────────────────
app.use(require('./routes/video-comments')({ db, auth, isProjectMember, safeJsonParse, attachmentUploadMiddleware, emitToProject, extractMentionedUserIds, createNotification, safeUnlink }));

// ─── SHARES (links de revisión sin cuenta para clientes: por video y por cliente) ────────────
app.use(require('./routes/shares')({ db, auth, serveFile, safeJsonParse, emitToProject, createNotification }));

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

// Mismo formato que MentionInput.jsx guarda en el texto: @[Nombre](userId) — parseable sin
// ambigüedad server-side (dos personas se pueden llamar igual), a diferencia de buscar "@Nombre"
// como texto plano.
function extractMentionedUserIds(content) {
  if (!content) return [];
  const re = /@\[[^\]]+\]\(([a-zA-Z0-9-]+)\)/g;
  const ids = new Set();
  let m;
  while ((m = re.exec(content))) ids.add(m[1]);
  return [...ids];
}

// Se llama SIEMPRE después de que la acción principal (crear tarea, comentario, proyecto, etc.)
// ya se guardó y se emitió por socket. Si esto tira una excepción sin capturarla acá, el catch del
// endpoint que la llamó responde 500 al usuario aunque su acción ya se haya aplicado con éxito —
// ve un error falso, puede reintentar, y termina duplicando lo que acaba de crear. Por eso nunca
// propaga: en el peor caso se pierde una notificación, no la acción del usuario.
async function createNotification(args) {
  try {
    return await createNotificationInner(args);
  } catch (e) {
    console.error('Error creando notificación (no se propaga):', e);
    return null;
  }
}
async function createNotificationInner({ userId, type, actorId, guestName, projectId, videoId, commentId, chatMessageId, preview }) {
  if (userId && userId === actorId) return; // don't notify yourself

  // Silenciado gana sobre cualquier tipo de aviso de ESE proyecto — salvo una mención directa
  // (@nombre), que es un pedido explícito de atención puntual, no ruido ambiente del proyecto en
  // general. Mismo criterio que silenciar un canal en Slack: las menciones igual llegan.
  if (projectId && type !== 'mention') {
    const muted = await db('notification_mutes').where({ user_id: userId, project_id: projectId }).first();
    if (muted) return;
  }

  // Notificaciones de chat de proyecto: agrupar las no leídas del mismo emisor en una sola, en vez
  // de crear una fila nueva por cada mensaje — alguien escribiendo 10 mensajes seguidos generaba
  // 10 notificaciones separadas. (Esto apuntaba a `type === 'chat'`, un tipo que nunca se llegó a
  // usar en ningún lado — el chat de proyecto siempre mandó 'project_message', así que este bloque
  // quedó de código muerto hasta ahora.)
  if (type === 'project_message') {
    const existing = await db('notifications')
      .where({ user_id: userId, actor_id: actorId, type: 'project_message', read: false })
      .first();
    if (existing) {
      await db('notifications').where({ id: existing.id }).update({
        preview: preview || existing.preview,
        chat_message_id: chatMessageId || existing.chat_message_id,
        created_at: new Date().toISOString(),
      });
      const updated = await db('notifications as n')
        .leftJoin('users as a', 'n.actor_id', 'a.id')
        .leftJoin('projects as p', 'n.project_id', 'p.id')
        .where('n.id', existing.id)
        .select('n.*', 'a.avatar_color as actor_color', 'p.name as project_name')
        .select(db.raw("COALESCE(a.name, n.guest_name, 'Cliente') as actor_name"))
        .first();
      io.to(`user:${userId}`).emit('notification:new', updated);
      return updated;
    }
  }

  const id = uuidv4();
  // Un comentario del link de revisión (link de cliente externo) llega sin actor_id — no hay
  // cuenta de usuario detrás — así que se guarda guest_name en su lugar para poder mostrar de
  // quién es el aviso. Ver el COALESCE de abajo.
  await db('notifications').insert({ id, user_id: userId, type, actor_id: actorId || null, guest_name: guestName || null, project_id: projectId || null, video_id: videoId || null, comment_id: commentId || null, chat_message_id: chatMessageId || null, preview: preview || null });
  const notif = await db('notifications as n')
    .leftJoin('users as a', 'n.actor_id', 'a.id')
    .leftJoin('projects as p', 'n.project_id', 'p.id')
    .where('n.id', id)
    .select('n.*', 'a.avatar_color as actor_color', 'p.name as project_name')
    .select(db.raw("COALESCE(a.name, n.guest_name, 'Cliente') as actor_name"))
    .first();
  io.to(`user:${userId}`).emit('notification:new', notif);
  return notif;
}

app.use(require('./routes/notifications')({ db, auth, io, parseReadBy }));

// ─── CHAT ─────────────────────────────────────────────────────────────────────
app.use(require('./routes/chat')({ db, auth, io, uploadLimiter, attachmentUpload, verifyAndPersistFiles, SAFE_ATTACHMENT_MIME_EXT }));

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
// Mismo criterio que el middleware HTTP: el rol se revalida contra la DB, no se confía en el token.
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const current = await db('users').where({ id: decoded.id }).select('id', 'role').first();
    if (!current) return next(new Error('Token inválido'));
    socket.userId = current.id;
    socket.userRole = current.role;
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

// userId -> { socketId, role }
const onlineUsers = new Map();

// Un editor nunca debe ver la lista completa de usuarios online (privacidad entre editores):
// solo ve admins + compañeros con los que comparte un canal de chat. El admin sí ve a todos.
async function broadcastOnlineUsers() {
  const onlineIds = Array.from(onlineUsers.keys());
  const adminIds = onlineIds.filter(id => onlineUsers.get(id).role === 'admin');
  io.to('admins').emit('users:online', onlineIds);

  const nonAdminIds = onlineIds.filter(id => onlineUsers.get(id).role !== 'admin');
  for (const uid of nonAdminIds) {
    const visible = new Set([...adminIds, uid]);
    const channelIds = await db('chat_channel_members').where({ user_id: uid }).pluck('channel_id');
    if (channelIds.length > 0) {
      const mates = await db('chat_channel_members').whereIn('channel_id', channelIds).pluck('user_id');
      mates.forEach(m => { if (onlineUsers.has(m)) visible.add(m); });
    }
    io.to(`user:${uid}`).emit('users:online', Array.from(visible));
  }
}

io.on('connection', (socket) => {
  socket.on('user:online', async () => {
    try {
      onlineUsers.set(socket.userId, { socketId: socket.id, role: socket.userRole });
      socket.join(`user:${socket.userId}`);
      if (socket.userRole === 'admin') socket.join('admins');
      await broadcastOnlineUsers();
    } catch (e) { console.error('socket user:online:', e); }
  });
  socket.on('project:join', async (projectId) => {
    try {
      if (!projectId || typeof projectId !== 'string') return;
      const allowed = await isProjectMember(socket.userId, socket.userRole, projectId);
      if (!allowed) return;
      socket.join(`project:${projectId}`);
    } catch (e) { console.error('socket project:join:', e); }
  });
  // Sin esto, un socket que navegó por muchos proyectos en una sesión larga se queda unido a
  // todas esas rooms para siempre (solo había join, nunca leave) — recibe eventos de proyectos
  // que ya no está mirando, acumulando tráfico innecesario.
  socket.on('project:leave', (projectId) => {
    if (!projectId || typeof projectId !== 'string') return;
    socket.leave(`project:${projectId}`);
  });
  // Acepta un callback opcional de ack: antes esto era "fire and forget" — el input se
  // vaciaba apenas se emitía, sin esperar confirmación. Si el socket estaba desconectado en
  // ese instante, el mensaje se perdía sin que el usuario se enterara. Con .timeout() del lado
  // del cliente, la ausencia de ack pasa a ser un error visible en vez de un silencio.
  socket.on('message:send', async (data, callback) => {
    try {
      const { project_id, content, type } = data || {};
      if (!project_id || typeof project_id !== 'string' || !content?.trim()) return callback?.({ error: 'Mensaje inválido' });
      const sender = await db('users').where({ id: socket.userId }).first();
      if (!sender) return callback?.({ error: 'Usuario no válido' });
      const allowed = await isProjectMember(socket.userId, socket.userRole, project_id);
      if (!allowed) return callback?.({ error: 'No tenés acceso a este proyecto' });
      const id = uuidv4();
      await db('messages').insert({ id, project_id, sender_id: socket.userId, receiver_id: null, content, type: type || 'project' });
      const msg = { id, project_id, sender_id: socket.userId, receiver_id: null, content, type, sender_name: sender.name, sender_color: sender.avatar_color, created_at: new Date().toISOString() };
      io.to(`project:${project_id}`).emit('message:new', msg);
      callback?.({ success: true, message: msg });

      // Antes solo se emitía por socket — un usuario offline nunca se enteraba de mensajes perdidos.
      const memberIds = await db('project_members').where({ project_id }).pluck('user_id');
      const adminIds = await db('users').where({ role: 'admin' }).pluck('id');
      const notifyIds = new Set([...memberIds, ...adminIds]);
      notifyIds.delete(socket.userId);
      // A quien mencionaron le llega "te mencionaron" en vez del genérico "escribió en el chat" —
      // mandarle los dos sería el mismo mensaje anunciado dos veces distintas.
      const mentionedIds = new Set(extractMentionedUserIds(content).filter(uid => notifyIds.has(uid)));
      for (const uid of notifyIds) {
        const type = mentionedIds.has(uid) ? 'mention' : 'project_message';
        await createNotification({ userId: uid, type, actorId: socket.userId, projectId: project_id, chatMessageId: id, preview: content?.slice(0, 80) });
      }
    } catch (e) {
      console.error('socket message:send:', e);
      callback?.({ error: 'Error al enviar el mensaje' });
    }
  });
  socket.on('disconnect', async () => {
    try {
      for (const [userId, info] of onlineUsers.entries()) {
        if (info.socketId === socket.id) { onlineUsers.delete(userId); break; }
      }
      await broadcastOnlineUsers();
    } catch (e) { console.error('socket disconnect:', e); }
  });
});

// ─── CLIENT ESTÁTICO (producción) ────────────────────────────────────────────
const clientDist = path.join(__dirname, '../client/dist');
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Error handler final de Express (va después de todas las rutas). Sin esto, un error síncrono
// que no atrapa ninguna ruta — por ejemplo un JSON malformado en el body, que revienta dentro de
// express.json() antes de llegar al handler — cae en el manejador por defecto de Express, que
// responde con el stack trace completo (rutas absolutas del server, estructura de módulos) salvo
// que NODE_ENV=production. Esto lo cubre independientemente de cómo esté configurado el entorno.
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  if (res.headersSent) return next(err);
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Red de seguridad: sin esto, una sola promesa rechazada fuera de un try/catch (un corte de
// conexión con la DB en medio de un request, un handler de socket con payload inesperado)
// termina el proceso y tira la app para todos los usuarios hasta que Render la reinicie.
// A propósito NO se hace process.exit() acá: el estado en memoria es descartable (onlineUsers,
// uploadSessions) y todo lo importante vive en Postgres, así que seguir vivo y loguear fuerte
// es estrictamente mejor que morirse y dejar a todo el equipo esperando un cold start.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Promesa rechazada sin manejar:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Excepción no capturada:', err);
});

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 AgencyOS corriendo en http://localhost:${PORT}`);
    console.log(`👤 Admin: admin@agencyos.com / admin123\n`);
  });
}).catch(e => { console.error('Error iniciando DB:', e); process.exit(1); });
