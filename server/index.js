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
const rateLimit = require('express-rate-limit');

function parseReadBy(val) {
  if (!val) return [];
  try {
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const app = express();
const server = http.createServer(app);

// CORS: lista separada por comas (ej: "https://app.midominio.com,https://otro.com").
// Sin configurar, permite cualquier origen (comportamiento local por defecto).
const corsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map(o => o.trim())
  : '*';

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

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 3 * 1024 * 1024 * 1024 } });

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
      useNullAsDefault: true
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
  const hasMsgRead = await db.schema.hasColumn('chat_messages', 'read_by');
  if (!hasMsgRead) {
    await db.schema.table('chat_messages', t => { t.text('read_by').defaultTo('[]'); });
  }

  const hasChatClientId = await db.schema.hasColumn('chat_messages', 'client_id');
  if (!hasChatClientId) {
    await db.schema.table('chat_messages', t => { t.string('client_id').nullable(); });
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

  const hasCompletedAt = await db.schema.hasColumn('projects', 'completed_at');
  if (!hasCompletedAt) {
    await db.schema.table('projects', t => { t.timestamp('completed_at').nullable(); });
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

  // Seed admin
  const admin = await db('users').where({ email: 'admin@agencyos.com' }).first();
  if (!admin) {
    const hash = bcrypt.hashSync('admin123', 10);
    await db('users').insert({ id: uuidv4(), name: 'Admin', email: 'admin@agencyos.com', password: hash, role: 'admin', avatar_color: '#f59e0b' });
    console.log('✅ Admin creado: admin@agencyos.com / admin123');
  }
}

app.use(cors({ origin: corsOrigin }));
app.use(express.json());
app.use('/uploads', express.static(uploadsDir));

const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Sesión no iniciada' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
};

// ─── PROJECT MEMBERSHIP ───────────────────────────────────────────────────────

async function isProjectMember(userId, role, projectId) {
  if (role === 'admin') return true;
  if (!projectId) return false;
  const member = await db('project_members').where({ project_id: projectId, user_id: userId }).first();
  return !!member;
}

async function addProjectMember(projectId, userId, role = 'member') {
  if (!projectId || !userId) return;
  const existing = await db('project_members').where({ project_id: projectId, user_id: userId }).first();
  if (!existing) await db('project_members').insert({ project_id: projectId, user_id: userId, role });
}

// Emite un evento solo a los miembros de un proyecto (via sus rooms personales) y a todos los admins.
async function emitToProject(projectId, event, data) {
  const memberIds = await db('project_members').where({ project_id: projectId }).pluck('user_id');
  const adminIds = await db('users').where({ role: 'admin' }).pluck('id');
  const targetIds = new Set([...memberIds, ...adminIds]);
  for (const uid of targetIds) {
    io.to(`user:${uid}`).emit(event, data);
  }
}

// Middleware: requiere ser miembro del proyecto indicado por :projectId (o admin).
function requireProjectAccess(paramName = 'projectId') {
  return async (req, res, next) => {
    if (req.user.role === 'admin') return next();
    const projectId = req.params[paramName];
    if (!projectId) return res.status(400).json({ error: 'Proyecto no especificado' });
    const membership = await db('project_members')
      .where({ project_id: projectId, user_id: req.user.id }).first();
    if (!membership) return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    next();
  };
}

// Rate limiting para login: previene ataques de fuerza bruta.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Probá de nuevo más tarde.' }
});

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', loginLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar_color: user.avatar_color } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/auth/register', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, email, password, role } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre es obligatorio' });
    if (!email?.trim()) return res.status(400).json({ error: 'El email es obligatorio' });
    if (!password || password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    const exists = await db('users').where({ email }).first();
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = bcrypt.hashSync(password, 10);
    const colors = ['#6366f1','#ec4899','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    await db('users').insert({ id: uuidv4(), name, email, password: hash, role: role || 'editor', avatar_color: color });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET /api/users — admins ven todo, editores solo ven admins + sí mismos (privacidad entre editores).
app.get('/api/users', auth, async (req, res) => {
  if (req.user.role === 'admin') {
    const users = await db('users').select('id','name','email','role','avatar_color','created_at');
    return res.json(users);
  }
  const users = await db('users')
    .where(function() { this.where({ role: 'admin' }).orWhere({ id: req.user.id }); })
    .select('id','name','email','role','avatar_color','created_at');
  res.json(users);
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const uid = req.params.id;
    const target = await db('users').where({ id: uid }).first();
    if (!target) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (target.role === 'admin') {
      const adminCount = await db('users').where({ role: 'admin' }).count('id as c').first();
      if (Number(adminCount.c) <= 1) return res.status(400).json({ error: 'No se puede eliminar el último administrador' });
    }
    await db('notifications').where({ user_id: uid }).orWhere({ actor_id: uid }).delete();
    await db('messages').where({ sender_id: uid }).delete();
    await db('chat_messages').where({ sender_id: uid }).delete();
    await db('chat_channel_members').where({ user_id: uid }).delete();
    await db('project_members').where({ user_id: uid }).delete();
    await db('tasks').where({ assigned_to: uid }).update({ assigned_to: null });
    await db('video_comments').where({ user_id: uid }).delete();
    await db('comment_replies').where({ user_id: uid }).delete();
    await db('users').where({ id: uid }).delete();
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// PATCH /api/users/:id — editar usuario (admin, o el propio usuario)
app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const { name, email, role, avatar_color, password, current_password } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (email) {
      const existing = await db('users').where({ email }).whereNot({ id: req.params.id }).first();
      if (existing) return res.status(400).json({ error: 'Email ya en uso por otro usuario' });
      updateData.email = email;
    }
    if (role && req.user.role === 'admin') {
      const target = await db('users').where({ id: req.params.id }).first();
      if (target?.role === 'admin' && role !== 'admin') {
        const adminCount = await db('users').where({ role: 'admin' }).count('id as c').first();
        if (Number(adminCount.c) <= 1) return res.status(400).json({ error: 'No se puede cambiar el rol del último administrador' });
      }
      updateData.role = role;
    }
    if (avatar_color) updateData.avatar_color = avatar_color;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      if (req.user.id === req.params.id) {
        const target = await db('users').where({ id: req.params.id }).first();
        if (!current_password || !bcrypt.compareSync(current_password, target.password)) {
          return res.status(400).json({ error: 'Contraseña actual incorrecta' });
        }
      }
      updateData.password = bcrypt.hashSync(password, 10);
    }
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    await db('users').where({ id: req.params.id }).update(updateData);
    const updated = await db('users').where({ id: req.params.id }).select('id', 'name', 'email', 'role', 'avatar_color', 'created_at').first();
    res.json(updated);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── PROJECTS ────────────────────────────────────────────────────────────────
app.get('/api/projects', auth, async (req, res) => {
  try {
    let query = db('projects as p')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .leftJoin('users as eu', 'p.payment_editor_id', 'eu.id')
      .select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color')
      .orderBy('p.created_at', 'desc');

    if (req.user.role !== 'admin') {
      const memberProjectIds = await db('project_members')
        .where({ user_id: req.user.id }).pluck('project_id');
      query = query.whereIn('p.id', memberProjectIds);
    }

    const projects = await query;
    const taskCounts = await db('tasks')
      .select('project_id')
      .count('* as task_count')
      .select(db.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as done_count', ['done']))
      .select(db.raw('SUM(CASE WHEN status = ? THEN 1 ELSE 0 END) as review_count', ['review']))
      .groupBy('project_id');
    const countsMap = {};
    for (const row of taskCounts) {
      countsMap[row.project_id] = { task_count: Number(row.task_count), done_count: Number(row.done_count), review_count: Number(row.review_count) };
    }
    const withCounts = projects.map(p => ({ ...p, ...(countsMap[p.id] || { task_count: 0, done_count: 0, review_count: 0 }) }));
    res.json(withCounts);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.get('/api/projects/:id', auth, requireProjectAccess('id'), async (req, res) => {
  try {
    const project = await db('projects as p')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .leftJoin('users as eu', 'p.payment_editor_id', 'eu.id')
      .where('p.id', req.params.id)
      .select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color')
      .first();
    if (!project) return res.status(404).json({ error: 'No encontrado' });
    res.json(project);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/projects', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Solo el admin puede crear proyectos' });
    const { name, description, color, payment_editor_id, payment_type, payment_amount, payment_hours, client_id, deadline, client_amount } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre del proyecto es obligatorio' });
    if (!payment_editor_id) return res.status(400).json({ error: 'Tenés que asignar un editor al proyecto' });
    const id = uuidv4();
    await db('projects').insert({
      id, name, description, color: color || '#6366f1', created_by: req.user.id,
      client_id: client_id || null,
      deadline: deadline || null,
      payment_editor_id: payment_editor_id || null,
      payment_type: payment_type || 'fixed',
      payment_amount: parseFloat(payment_amount) || 0,
      payment_hours: parseFloat(payment_hours) || 0,
      client_amount: parseFloat(client_amount) || 0,
      payment_status: 'unpaid',
      upwork_status: 'pending'
    });
    await addProjectMember(id, req.user.id, 'owner');
    if (payment_editor_id) await addProjectMember(id, payment_editor_id);
    const project = await db('projects').where({ id }).first();
    await emitToProject(id, 'project:created', project);
    await createNotification({ userId: payment_editor_id, type: 'project_assigned', actorId: req.user.id, projectId: id, preview: name });
    res.json(project);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.put('/api/projects/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const existing = await db('projects').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const { name, description, color, status, payment_editor_id, payment_type, payment_amount, payment_hours, payment_status, upwork_status, client_id, deadline, client_amount } = req.body;
    const update = {
      name, description, color, status,
      client_id: client_id || null,
      deadline: deadline || null,
      payment_editor_id: payment_editor_id || null,
      payment_type, payment_amount, payment_hours, payment_status, upwork_status
    };
    if (client_amount !== undefined) update.client_amount = parseFloat(client_amount) || 0;
    await db('projects').where({ id: req.params.id }).update(update);
    if (payment_editor_id) await addProjectMember(req.params.id, payment_editor_id);
    if (payment_editor_id && payment_editor_id !== existing.payment_editor_id) {
      await createNotification({ userId: payment_editor_id, type: 'project_assigned', actorId: req.user.id, projectId: req.params.id, preview: name || existing.name });
    }
    const project = await db('projects as p').leftJoin('clients as c', 'p.client_id', 'c.id').leftJoin('users as eu', 'p.payment_editor_id', 'eu.id').where('p.id', req.params.id).select('p.*', 'c.name as client_name', 'c.color as client_color', 'eu.name as payment_editor_name', 'eu.avatar_color as payment_editor_color').first();
    await emitToProject(req.params.id, 'project:updated', project);
    res.json(project);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/projects/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const projectId = req.params.id;

    const videos = await db('videos').where({ project_id: projectId });
    for (const video of videos) {
      const filePath = path.join(uploadsDir, video.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      const commentIds = await db('video_comments').where({ video_id: video.id }).pluck('id');
      if (commentIds.length > 0) {
        const replyIds = await db('comment_replies').whereIn('comment_id', commentIds).pluck('id');
        if (replyIds.length > 0) {
          await db('reply_attachments').whereIn('reply_id', replyIds).delete();
        }
        await db('comment_attachments').whereIn('comment_id', commentIds).delete();
        await db('comment_replies').whereIn('comment_id', commentIds).delete();
        await db('video_comments').whereIn('id', commentIds).delete();
      }
    }
    await db('videos').where({ project_id: projectId }).delete();

    await db('tasks').where({ project_id: projectId }).delete();
    await db('messages').where({ project_id: projectId }).delete();
    await db('notifications').where({ project_id: projectId }).delete();

    // Emitir antes de borrar miembros para que llegue a los destinatarios correctos
    await emitToProject(projectId, 'project:deleted', { id: projectId });
    await db('project_members').where({ project_id: projectId }).delete();

    await db('projects').where({ id: projectId }).delete();
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── PROJECT MEMBERS CRUD ───────────────────────────────────────────────────
app.get('/api/projects/:projectId/members', auth, requireProjectAccess(), async (req, res) => {
  try {
    const members = await db('project_members as pm')
      .join('users as u', 'pm.user_id', 'u.id')
      .where('pm.project_id', req.params.projectId)
      .select('u.id', 'u.name', 'u.avatar_color', 'u.role', 'pm.role as member_role');
    res.json(members);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/projects/:projectId/members', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { user_id } = req.body;
    const user = await db('users').where({ id: user_id }).first();
    if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
    await addProjectMember(req.params.projectId, user_id);
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/projects/:projectId/members/:userId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    await db('project_members').where({ project_id: req.params.projectId, user_id: req.params.userId }).delete();
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

app.get('/api/clients', auth, async (req, res) => {
  try {
    const clients = await db('clients').orderBy('name', 'asc');
    res.json(clients);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, color, email, phone, notes } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
    const id = uuidv4();
    await db('clients').insert({ id, name, color: color || '#6366f1', email: email || null, phone: phone || null, notes: notes || null });
    const client = await db('clients').where({ id }).first();
    res.json(client);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.patch('/api/clients/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, color, email, phone, notes } = req.body;
    if (name !== undefined && !name?.trim()) return res.status(400).json({ error: 'El nombre del cliente es obligatorio' });
    await db('clients').where({ id: req.params.id }).update({ name, color, email, phone, notes });
    const client = await db('clients').where({ id: req.params.id }).first();
    res.json(client);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    await db('projects').where({ client_id: req.params.id }).update({ client_id: null });
    await db('chat_messages').where({ client_id: req.params.id }).update({ client_id: null });
    await db('clients').where({ id: req.params.id }).delete();
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── DASHBOARD ──────────────────────────────────────────────────────────────
app.get('/api/dashboard/pending-videos', auth, async (req, res) => {
  try {
    let projectFilter = null;
    if (req.user.role !== 'admin') {
      projectFilter = await db('project_members')
        .where({ user_id: req.user.id }).pluck('project_id');
    }

    // Videos vinculados a tareas en revisión
    let reviewQuery = db('videos as v')
      .join('tasks as tk', function() {
        this.on('v.task_id', 'tk.id').andOn('tk.status', db.raw('?', ['review']));
      })
      .join('projects as p', 'v.project_id', 'p.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .leftJoin('users as u', 'v.uploaded_by', 'u.id')
      .select(
        'v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
        'p.name as project_name', 'p.color as project_color',
        'c.name as client_name',
        'u.name as uploader_name',
        'tk.title as task_title',
        db.raw('? as type', ['review'])
      );
    if (projectFilter) reviewQuery = reviewQuery.whereIn('v.project_id', projectFilter);
    const reviewVideos = await reviewQuery;

    // Videos con comentarios sin resolver (excluyendo los que ya están en revisión)
    const reviewVideoIds = reviewVideos.map(v => v.id);
    let commentsQuery = db('videos as v')
      .join('video_comments as vc', function() {
        this.on('vc.video_id', 'v.id').andOn('vc.resolved', db.raw('?', [false]));
      })
      .join('projects as p', 'v.project_id', 'p.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .leftJoin('users as u', 'v.uploaded_by', 'u.id')
      .select(
        'v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
        'p.name as project_name', 'p.color as project_color',
        'c.name as client_name',
        'u.name as uploader_name',
        db.raw('count(vc.id) as unresolved_count'),
        db.raw('? as type', ['comments'])
      )
      .groupBy('v.id', 'v.title', 'v.version', 'v.project_id', 'v.created_at',
        'p.name', 'p.color', 'c.name', 'u.name');
    if (projectFilter) commentsQuery = commentsQuery.whereIn('v.project_id', projectFilter);
    if (reviewVideoIds.length > 0) commentsQuery = commentsQuery.whereNotIn('v.id', reviewVideoIds);
    const commentVideos = await commentsQuery;

    res.json([...reviewVideos, ...commentVideos]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── EDITOR DETAIL (admin only) ─────────────────────────────────────────────
app.get('/api/users/:id/detail', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const editorId = req.params.id;
    const editor = await db('users').where({ id: editorId }).select('id', 'name', 'email', 'role', 'avatar_color', 'created_at').first();
    if (!editor) return res.status(404).json({ error: 'Usuario no encontrado' });

    const tasks = await db('tasks as t')
      .join('projects as p', 't.project_id', 'p.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .where('t.assigned_to', editorId)
      .select('t.*', 'p.name as project_name', 'p.color as project_color', 'c.name as client_name');

    const projects = await db('projects as p')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .where('p.payment_editor_id', editorId)
      .select('p.id', 'p.name', 'p.color', 'p.editor_paid', 'p.client_paid', 'p.payment_amount', 'p.payment_type', 'p.payment_hours', 'c.name as client_name');

    res.json({ editor, tasks, projects });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
app.get('/api/payments', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const projectsWithDoneTasks = await db('tasks').where({ status: 'done' }).distinct('project_id').pluck('project_id');
    const projects = await db('projects as p')
      .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .whereNotNull('p.payment_editor_id')
      .whereIn('p.id', projectsWithDoneTasks)
      .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
      .orderBy('p.created_at', 'desc');
    res.json(projects);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.patch('/api/payments/:projectId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const existing = await db('projects').where({ id: req.params.projectId }).first();
    if (!existing) return res.status(404).json({ error: 'Proyecto no encontrado' });
    const { payment_hours, payment_status, upwork_status, payment_amount } = req.body;
    const update = {};
    if (payment_hours !== undefined) update.payment_hours = parseFloat(payment_hours) || 0;
    if (payment_status !== undefined) update.payment_status = payment_status;
    if (upwork_status !== undefined) update.upwork_status = upwork_status;
    if (payment_amount !== undefined) update.payment_amount = parseFloat(payment_amount) || 0;
    if (req.body.editor_paid !== undefined) update.editor_paid = req.body.editor_paid;
    if (req.body.client_paid !== undefined) update.client_paid = req.body.client_paid;
    await db('projects').where({ id: req.params.projectId }).update(update);
    const current = await db('projects').where({ id: req.params.projectId }).first();
    const isCompleted = current.editor_paid === 'paid' && current.client_paid === 'cobrado';
    if (isCompleted && !current.completed_at) {
      await db('projects').where({ id: req.params.projectId }).update({ completed_at: new Date().toISOString() });
    } else if (!isCompleted && current.completed_at) {
      await db('projects').where({ id: req.params.projectId }).update({ completed_at: null });
    }
    const project = await db('projects as p')
      .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .where('p.id', req.params.projectId)
      .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
      .first();
    io.to('admins').emit('payment:updated', project);
    res.json(project);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── TASKS ───────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/tasks', auth, requireProjectAccess(), async (req, res) => {
  try {
    let query = db('tasks as t')
      .leftJoin('users as u', 't.assigned_to', 'u.id')
      .where('t.project_id', req.params.projectId)
      .select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color');
    if (req.user.role !== 'admin') query = query.where('t.assigned_to', req.user.id);
    const tasks = await query
      .orderBy('t.created_at', 'asc');
    res.json(tasks);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/projects/:projectId/tasks', auth, requireProjectAccess(), async (req, res) => {
  try {
    const { title, description, status, priority, assigned_to, due_date } = req.body;
    if (!title?.trim()) return res.status(400).json({ error: 'El título de la tarea es obligatorio' });
    const id = uuidv4();
    await db('tasks').insert({ id, project_id: req.params.projectId, title, description, status: status || 'todo', priority: priority || 'medium', assigned_to: assigned_to || null, created_by: req.user.id, due_date: due_date || null });
    if (assigned_to) await addProjectMember(req.params.projectId, assigned_to);
    const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
    await emitToProject(req.params.projectId, 'task:created', task);
    if (assigned_to) {
      const project = await db('projects').where({ id: req.params.projectId }).first();
      await createNotification({ userId: assigned_to, type: 'task_assigned', actorId: req.user.id, projectId: req.params.projectId, preview: `"${title}" en ${project?.name || 'proyecto'}` });
    }
    res.json(task);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  try {
    const existing = await db('tasks').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (!await isProjectMember(req.user.id, req.user.role, existing.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    const { title, description, status, priority, assigned_to, due_date } = req.body;
    if (req.user.role !== 'admin') {
      if (existing.assigned_to !== req.user.id) return res.status(403).json({ error: 'Solo podés cambiar el estado de tus tareas asignadas' });
      await db('tasks').where({ id: req.params.id }).update({ status, updated_at: new Date().toISOString() });
    } else {
      await db('tasks').where({ id: req.params.id }).update({ title, description, status, priority, assigned_to: assigned_to || null, due_date: due_date || null, updated_at: new Date().toISOString() });
      if (assigned_to) {
        await addProjectMember(existing.project_id, assigned_to);
        const project = await db('projects').where({ id: existing.project_id }).first();
        if (!project.payment_editor_id) {
          const assignedUser = await db('users').where({ id: assigned_to }).first();
          if (assignedUser && assignedUser.role !== 'admin') {
            await db('projects').where({ id: existing.project_id }).update({ payment_editor_id: assigned_to });
          }
        }
        if (assigned_to !== existing.assigned_to) {
          await createNotification({ userId: assigned_to, type: 'task_assigned', actorId: req.user.id, projectId: existing.project_id, preview: `"${title || existing.title}" en ${project?.name || 'proyecto'}` });
        }
      }
    }
    const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', req.params.id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
    await emitToProject(existing.project_id, 'task:updated', task);
    if (status === 'review' && existing.status !== 'review') {
      const admins = await db('users').where({ role: 'admin' }).select('id');
      const project = await db('projects').where({ id: existing.project_id }).first();
      for (const admin of admins) {
        await createNotification({ userId: admin.id, type: 'task_review', actorId: req.user.id, projectId: existing.project_id, preview: `"${existing.title}" en ${project?.name || 'proyecto'}` });
      }
    }
    res.json(task);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  try {
    const existing = await db('tasks').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Tarea no encontrada' });
    if (!await isProjectMember(req.user.id, req.user.role, existing.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    if (req.user.role !== 'admin' && existing.assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Solo podés eliminar tus tareas asignadas' });
    }
    await db('tasks').where({ id: req.params.id }).delete();
    await emitToProject(existing.project_id, 'task:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/messages', auth, requireProjectAccess(), async (req, res) => {
  try {
    const { before } = req.query;
    let query = db('messages as m').join('users as u', 'm.sender_id', 'u.id')
      .where({ 'project_id': req.params.projectId, 'type': 'project' })
      .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
    if (before) {
      const ref = await db('messages').where({ id: before }).first();
      if (ref) query = query.where('m.created_at', '<', ref.created_at);
    }
    const messages = await query.orderBy('m.created_at', 'desc').limit(50);
    res.json(messages.reverse());
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── VIDEOS ──────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/videos', auth, requireProjectAccess(), async (req, res) => {
  try {
    const videos = await db('videos as v')
      .leftJoin('users as u', 'v.uploaded_by', 'u.id')
      .leftJoin('tasks as tk', 'v.task_id', 'tk.id')
      .where('v.project_id', req.params.projectId)
      .select('v.*', 'u.name as uploader_name', 'tk.title as task_title')
      .orderBy('v.created_at', 'desc');
    res.json(videos);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/projects/:projectId/videos', auth, requireProjectAccess(), upload.single('video'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún video' });
    const { title, version, task_id, stack_with } = req.body;
    const id = uuidv4();
    let groupId = null;
    if (stack_with) {
      const parentVideo = await db('videos').where({ id: stack_with }).first();
      if (parentVideo && parentVideo.project_id === req.params.projectId) {
        groupId = parentVideo.group_id || uuidv4();
        if (!parentVideo.group_id) {
          await db('videos').where({ id: stack_with }).update({ group_id: groupId });
        }
      }
    }
    await db('videos').insert({ id, project_id: req.params.projectId, title: title || req.file.originalname, filename: req.file.filename, original_name: req.file.originalname, version: parseInt(version) || 1, uploaded_by: req.user.id, file_size: req.file.size, task_id: task_id || null, group_id: groupId });
    const video = await db('videos as v').leftJoin('users as u', 'v.uploaded_by', 'u.id').leftJoin('tasks as tk', 'v.task_id', 'tk.id').where('v.id', id).select('v.*', 'u.name as uploader_name', 'tk.title as task_title').first();
    await emitToProject(req.params.projectId, 'video:uploaded', video);
    // Check storage after upload
    const bytes = getUploadsSize();
    if (bytes >= STORAGE_WARN_BYTES) {
      const admins = await db('users').where({ role: 'admin' }).pluck('id');
      admins.forEach(adminId => io.to(`user:${adminId}`).emit('storage:warning', { bytes, gb: (bytes / (1024 ** 3)).toFixed(2) }));
    }
    res.json(video);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/videos/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const video = await db('videos').where({ id: req.params.id }).first();
    if (video) {
      const filePath = path.join(uploadsDir, video.filename);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      const commentIds = await db('video_comments').where({ video_id: req.params.id }).pluck('id');
      if (commentIds.length > 0) {
        const replyIds = await db('comment_replies').whereIn('comment_id', commentIds).pluck('id');
        if (replyIds.length > 0) {
          await db('reply_attachments').whereIn('reply_id', replyIds).delete();
        }
        await db('comment_attachments').whereIn('comment_id', commentIds).delete();
        await db('comment_replies').whereIn('comment_id', commentIds).delete();
      }
      await db('video_comments').where({ video_id: req.params.id }).delete();
    }
    await db('videos').where({ id: req.params.id }).delete();
    if (video) await emitToProject(video.project_id, 'video:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Stack: agrupa dos videos (o agrega uno a un grupo existente)
app.patch('/api/videos/:id/stack', auth, async (req, res) => {
  try {
    const { targetVideoId } = req.body;
    if (!targetVideoId) return res.status(400).json({ error: 'Falta targetVideoId' });
    const video = await db('videos').where({ id: req.params.id }).first();
    const target = await db('videos').where({ id: targetVideoId }).first();
    if (!video || !target) return res.status(404).json({ error: 'Video no encontrado' });
    if (video.project_id !== target.project_id) return res.status(400).json({ error: 'Los videos deben ser del mismo proyecto' });
    if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    const groupId = target.group_id || video.group_id || uuidv4();
    const idsToUpdate = [req.params.id, targetVideoId];
    if (video.group_id && video.group_id !== groupId) {
      const oldGroupMembers = await db('videos').where({ group_id: video.group_id }).pluck('id');
      idsToUpdate.push(...oldGroupMembers);
    }
    if (target.group_id && target.group_id !== groupId) {
      const oldGroupMembers = await db('videos').where({ group_id: target.group_id }).pluck('id');
      idsToUpdate.push(...oldGroupMembers);
    }
    await db('videos').whereIn('id', [...new Set(idsToUpdate)]).update({ group_id: groupId });
    await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
    res.json({ success: true, group_id: groupId });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Unstack: saca un video de su grupo
app.patch('/api/videos/:id/unstack', auth, async (req, res) => {
  try {
    const video = await db('videos').where({ id: req.params.id }).first();
    if (!video) return res.status(404).json({ error: 'Video no encontrado' });
    if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    if (!video.group_id) return res.json({ success: true });
    const groupId = video.group_id;
    await db('videos').where({ id: req.params.id }).update({ group_id: null });
    const remaining = await db('videos').where({ group_id: groupId });
    if (remaining.length === 1) {
      await db('videos').where({ id: remaining[0].id }).update({ group_id: null });
    }
    await emitToProject(video.project_id, 'video:updated', { projectId: video.project_id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── STORAGE CHECK ───────────────────────────────────────────────────────────

const STORAGE_WARN_BYTES = 20 * 1024 * 1024 * 1024; // 20GB
const STORAGE_CACHE_TTL = 60_000; // 60 segundos
let _storageCacheBytes = null;
let _storageCacheTime = 0;

function _scanUploadsSize(dir = uploadsDir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += _scanUploadsSize(fullPath);
      else total += fs.statSync(fullPath).size;
    } catch {}
  }
  return total;
}

function getUploadsSize() {
  const now = Date.now();
  if (_storageCacheBytes !== null && (now - _storageCacheTime) < STORAGE_CACHE_TTL) return _storageCacheBytes;
  _storageCacheBytes = _scanUploadsSize();
  _storageCacheTime = now;
  return _storageCacheBytes;
}

app.get('/api/storage', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
  const bytes = getUploadsSize();
  res.json({ bytes, gb: (bytes / (1024 ** 3)).toFixed(2), warning: bytes >= STORAGE_WARN_BYTES });
});

// ─── VIDEO COMMENTS ──────────────────────────────────────────────────────────
app.get('/api/videos/:videoId/comments', auth, async (req, res) => {
  try {
    const video = await db('videos').where({ id: req.params.videoId }).first();
    if (!video) return res.status(404).json({ error: 'Video no encontrado' });
    if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    const comments = await db('video_comments as vc').join('users as u', 'vc.user_id', 'u.id')
      .where('vc.video_id', req.params.videoId)
      .select('vc.*', 'u.name as user_name', 'u.avatar_color')
      .orderBy('vc.timestamp_sec', 'asc');
    const withAttachments = await Promise.all(comments.map(async c => ({
      ...c,
      attachments: await db('comment_attachments').where({ comment_id: c.id }),
      replies: await db('comment_replies as r').join('users as u', 'r.user_id', 'u.id').where('r.comment_id', c.id).select('r.*', 'u.name as user_name', 'u.avatar_color').orderBy('r.created_at', 'asc').then(replies =>
        Promise.all(replies.map(async r => ({ ...r, attachments: await db('reply_attachments').where({ reply_id: r.id }) })))
      ),
      annotation: c.annotation ? JSON.parse(c.annotation) : null
    })));
    res.json(withAttachments);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.post('/api/videos/:videoId/comments', auth, async (req, res, next) => {
  try {
    const video = await db('videos').where({ id: req.params.videoId }).first();
    if (!video) return res.status(404).json({ error: 'Video no encontrado' });
    if (!await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
}, upload.array('attachments', 5), async (req, res) => {
  try {
    const { content, timestamp_sec, timestamp_end, annotation } = req.body;
    const id = uuidv4();
    await db('video_comments').insert({
      id, video_id: req.params.videoId, user_id: req.user.id, content,
      timestamp_sec: parseFloat(timestamp_sec) || 0,
      timestamp_end: timestamp_end ? parseFloat(timestamp_end) : null,
      annotation: annotation || null
    });
    if (req.files?.length) {
      await db('comment_attachments').insert(req.files.map(f => ({ id: uuidv4(), comment_id: id, filename: f.filename, original_name: f.originalname })));
    }
    const comment = await db('video_comments as vc').join('users as u', 'vc.user_id', 'u.id').where('vc.id', id).select('vc.*', 'u.name as user_name', 'u.avatar_color').first();
    const attachments = await db('comment_attachments').where({ comment_id: id });
    const full = { ...comment, attachments, annotation: annotation ? JSON.parse(annotation) : null };
    const video = await db('videos').where({ id: req.params.videoId }).first();
    if (video) await emitToProject(video.project_id, 'comment:created', full);
    if (video) {
      const members = await db('users')
        .where('id', '!=', req.user.id)
        .where(function() {
          this.where({ role: 'admin' })
            .orWhereIn('id', db('video_comments').where({ video_id: req.params.videoId }).select('user_id'));
        });
      for (const m of members) {
        await createNotification({ userId: m.id, type: 'comment', actorId: req.user.id, projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
      }
    }
    res.json(full);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.patch('/api/comments/:id/resolve', auth, async (req, res) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
    const video = await db('videos').where({ id: comment.video_id }).first();
    if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    const resolved = !comment.resolved;
    await db('video_comments').where({ id: req.params.id }).update({ resolved });
    await emitToProject(video.project_id, 'comment:resolved', { id: req.params.id, resolved });
    res.json({ id: req.params.id, resolved });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.delete('/api/comments/:id', auth, async (req, res) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
    const video = await db('videos').where({ id: comment.video_id }).first();
    if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const replyIds = await db('comment_replies').where({ comment_id: req.params.id }).pluck('id');
    if (replyIds.length > 0) {
      await db('reply_attachments').whereIn('reply_id', replyIds).delete();
    }
    await db('comment_attachments').where({ comment_id: req.params.id }).delete();
    await db('comment_replies').where({ comment_id: req.params.id }).delete();
    await db('video_comments').where({ id: req.params.id }).delete();
    await emitToProject(video.project_id, 'comment:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET replies for a comment
app.get('/api/comments/:id/replies', auth, async (req, res) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
    const video = await db('videos').where({ id: comment.video_id }).first();
    if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    const replies = await db('comment_replies as r')
      .join('users as u', 'r.user_id', 'u.id')
      .where('r.comment_id', req.params.id)
      .select('r.*', 'u.name as user_name', 'u.avatar_color')
      .orderBy('r.created_at', 'asc');
    const withAttachments = await Promise.all(replies.map(async r => ({
      ...r,
      attachments: await db('reply_attachments').where({ reply_id: r.id })
    })));
    res.json(withAttachments);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST create reply
app.post('/api/comments/:id/replies', auth, async (req, res, next) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
    const video = await db('videos').where({ id: comment.video_id }).first();
    if (!video || !await isProjectMember(req.user.id, req.user.role, video.project_id)) {
      return res.status(403).json({ error: 'No tenés acceso a este proyecto' });
    }
    next();
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
}, upload.array('attachments', 5), async (req, res) => {
  try {
    const { content } = req.body;
    const id = uuidv4();
    await db('comment_replies').insert({ id, comment_id: req.params.id, user_id: req.user.id, content });
    if (req.files?.length) {
      await db('reply_attachments').insert(req.files.map(f => ({ id: uuidv4(), reply_id: id, filename: f.filename, original_name: f.originalname })));
    }
    const reply = await db('comment_replies as r').join('users as u', 'r.user_id', 'u.id').where('r.id', id).select('r.*', 'u.name as user_name', 'u.avatar_color').first();
    const attachments = await db('reply_attachments').where({ reply_id: id });
    const full = { ...reply, attachments };
    const parentComment = await db('video_comments').where({ id: req.params.id }).first();
    if (parentComment) {
      const video = await db('videos').where({ id: parentComment.video_id }).first();
      if (video) await emitToProject(video.project_id, 'comment:reply', full);
      await createNotification({ userId: parentComment.user_id, type: 'reply', actorId: req.user.id, projectId: video?.project_id, videoId: parentComment.video_id, commentId: req.params.id, preview: content?.slice(0, 80) });
    }
    res.json(full);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

async function createNotification({ userId, type, actorId, projectId, videoId, commentId, chatMessageId, preview }) {
  if (userId === actorId) return; // don't notify yourself

  // Notificaciones de chat: agrupar las no leídas del mismo emisor en una sola.
  if (type === 'chat') {
    const existing = await db('notifications')
      .where({ user_id: userId, actor_id: actorId, type: 'chat', read: false })
      .first();
    if (existing) {
      await db('notifications').where({ id: existing.id }).update({
        preview: preview || existing.preview,
        chat_message_id: chatMessageId || existing.chat_message_id,
        created_at: new Date().toISOString(),
      });
      const updated = await db('notifications as n')
        .join('users as a', 'n.actor_id', 'a.id')
        .leftJoin('projects as p', 'n.project_id', 'p.id')
        .where('n.id', existing.id)
        .select('n.*', 'a.name as actor_name', 'a.avatar_color as actor_color', 'p.name as project_name')
        .first();
      io.to(`user:${userId}`).emit('notification:new', updated);
      return updated;
    }
  }

  const id = uuidv4();
  await db('notifications').insert({ id, user_id: userId, type, actor_id: actorId, project_id: projectId || null, video_id: videoId || null, comment_id: commentId || null, chat_message_id: chatMessageId || null, preview: preview || null });
  const notif = await db('notifications as n')
    .join('users as a', 'n.actor_id', 'a.id')
    .leftJoin('projects as p', 'n.project_id', 'p.id')
    .where('n.id', id)
    .select('n.*', 'a.name as actor_name', 'a.avatar_color as actor_color', 'p.name as project_name')
    .first();
  io.to(`user:${userId}`).emit('notification:new', notif);
  return notif;
}

app.get('/api/notifications', auth, async (req, res) => {
  try {
    const notifs = await db('notifications as n')
      .join('users as a', 'n.actor_id', 'a.id')
      .leftJoin('projects as p', 'n.project_id', 'p.id')
      .where('n.user_id', req.user.id)
      .select('n.*', 'a.name as actor_name', 'a.avatar_color as actor_color', 'p.name as project_name')
      .orderBy('n.created_at', 'desc')
      .limit(50);
    res.json(notifs);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

app.patch('/api/notifications/read-all', auth, async (req, res) => {
  await db('notifications').where({ user_id: req.user.id }).update({ read: true });
  res.json({ success: true });
});

app.patch('/api/notifications/:id/read', auth, async (req, res) => {
  await db('notifications').where({ id: req.params.id, user_id: req.user.id }).update({ read: true });
  res.json({ success: true });
});

// GET unread counts for chat (per conversation)
app.get('/api/chat/unread', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const counts = {};

    // DMs: solo mensajes dirigidos a este usuario, no enviados por él
    const dmMsgs = await db('chat_messages')
      .where({ type: 'dm', receiver_id: userId })
      .whereNot({ sender_id: userId })
      .select('id', 'sender_id', 'read_by');
    for (const m of dmMsgs) {
      const readBy = parseReadBy(m.read_by);
      if (!readBy.includes(userId)) {
        const key = `dm:${m.sender_id}`;
        counts[key] = (counts[key] || 0) + 1;
      }
    }

    // Canales: solo los canales donde es miembro
    const memberChannels = await db('chat_channel_members').where({ user_id: userId }).pluck('channel_id');
    if (memberChannels.length > 0) {
      const channelMsgs = await db('chat_messages')
        .where({ type: 'channel' })
        .whereIn('channel_id', memberChannels)
        .whereNot({ sender_id: userId })
        .select('id', 'channel_id', 'read_by');
      for (const m of channelMsgs) {
        const readBy = parseReadBy(m.read_by);
        if (!readBy.includes(userId)) {
          const key = `channel:${m.channel_id}`;
          counts[key] = (counts[key] || 0) + 1;
        }
      }
    }

    res.json(counts);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// Mark messages as read
app.post('/api/chat/read', auth, async (req, res) => {
  try {
    const { type, id } = req.body;
    const userId = req.user.id;
    let msgs;
    if (type === 'dm') {
      msgs = await db('chat_messages').where({ type: 'dm', sender_id: id, receiver_id: userId }).orWhere({ type: 'dm', sender_id: userId, receiver_id: id });
    } else {
      msgs = await db('chat_messages').where({ type: 'channel', channel_id: id });
    }
    for (const m of msgs) {
      const readBy = parseReadBy(m.read_by);
      if (!readBy.includes(userId)) {
        readBy.push(userId);
        await db('chat_messages').where({ id: m.id }).update({ read_by: JSON.stringify(readBy) });
      }
    }
    io.to(`user:${userId}`).emit('chat:read', { type, id });
    res.json({ success: true });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────

app.get('/api/chat/dm-tabs', auth, async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) return res.status(400).json({ error: 'userId requerido' });
    const otherUser = await db('users').where({ id: userId }).first();
    if (!otherUser) return res.status(404).json({ error: 'Usuario no encontrado' });
    const editorId = req.user.role === 'admin' ? userId : req.user.id;
    const clients = await db('project_members as pm')
      .join('projects as p', 'pm.project_id', 'p.id')
      .join('clients as c', 'p.client_id', 'c.id')
      .where('pm.user_id', editorId)
      .whereNotNull('p.client_id')
      .select('c.id', 'c.name', 'c.color')
      .groupBy('c.id', 'c.name', 'c.color')
      .orderBy('c.name', 'asc');
    res.json(clients);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET conversations list for current user
app.get('/api/chat/conversations', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    let dms = [];
    if (isAdmin) {
      const allUsers = await db('users').where('id', '!=', userId).select('id', 'name', 'avatar_color');
      dms = await Promise.all(allUsers.map(async u => {
        const last = await db('chat_messages')
          .where(function() { this.where({ sender_id: userId, receiver_id: u.id, type: 'dm' }).orWhere({ sender_id: u.id, receiver_id: userId, type: 'dm' }); })
          .orderBy('created_at', 'desc').first();
        return { id: u.id, name: u.name, color: u.avatar_color, last_message: last?.content || (last?.file_type ? '📎 Archivo' : null), unread: 0 };
      }));
    } else {
      const admins = await db('users').where({ role: 'admin' }).select('id', 'name', 'avatar_color');
      dms = await Promise.all(admins.map(async (admin) => {
        const last = await db('chat_messages')
          .where(function() { this.where({ sender_id: userId, receiver_id: admin.id, type: 'dm' }).orWhere({ sender_id: admin.id, receiver_id: userId, type: 'dm' }); })
          .orderBy('created_at', 'desc').first();
        return { id: admin.id, name: admin.name, color: admin.avatar_color, last_message: last?.content || (last?.file_type ? '📎 Archivo' : null), unread: 0 };
      }));
    }

    let channels = [];
    if (isAdmin) {
      const allChannels = await db('chat_channels').orderBy('created_at', 'asc');
      channels = await Promise.all(allChannels.map(async c => {
        const [{ count }] = await db('chat_channel_members').where({ channel_id: c.id }).count('user_id as count');
        return { ...c, member_count: Number(count) };
      }));
    } else {
      const memberOf = await db('chat_channel_members').where({ user_id: userId }).pluck('channel_id');
      if (memberOf.length > 0) {
        channels = await db('chat_channels').whereIn('id', memberOf).orderBy('created_at', 'asc');
      }
    }

    res.json({ dms, channels });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// GET messages for a DM or channel (paginado: devuelve los más recientes primero).
// ?before=<id> para cargar mensajes anteriores.
app.get('/api/chat/messages', auth, async (req, res) => {
  try {
    const { type, id, before, client_id } = req.query;
    const userId = req.user.id;
    const PAGE_SIZE = 50;

    let query;
    if (type === 'dm') {
      query = db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .where('m.type', 'dm')
        .where(function() { this.where({ sender_id: userId, receiver_id: id }).orWhere({ sender_id: id, receiver_id: userId }); })
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
      if (client_id) {
        query = query.where('m.client_id', client_id);
      } else {
        query = query.whereNull('m.client_id');
      }
    } else if (type === 'channel') {
      if (req.user.role !== 'admin') {
        const isMember = await db('chat_channel_members').where({ channel_id: id, user_id: userId }).first();
        if (!isMember) return res.status(403).json({ error: 'Sin acceso' });
      }
      query = db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .where({ 'm.type': 'channel', 'm.channel_id': id })
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color');
    } else {
      return res.json([]);
    }

    if (before) {
      const ref = await db('chat_messages').where({ id: before }).first();
      if (ref) query = query.where('m.created_at', '<', ref.created_at);
    }

    const msgs = await query.orderBy('m.created_at', 'desc').limit(PAGE_SIZE);
    res.json(msgs.reverse());
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST send a message
app.post('/api/chat/messages', auth, async (req, res) => {
  try {
    const { type, receiver_id, channel_id, content, file_url, file_type, file_name, client_id } = req.body;
    const senderId = req.user.id;

    if (req.user.role !== 'admin' && type === 'dm') {
      const targetUser = await db('users').where({ id: receiver_id }).first();
      if (!targetUser || targetUser.role !== 'admin') {
        return res.status(403).json({ error: 'Los editores solo pueden chatear con admins' });
      }
    }
    if (req.user.role !== 'admin' && type === 'channel') {
      if (!channel_id) return res.status(400).json({ error: 'Canal no especificado' });
      const isMember = await db('chat_channel_members').where({ channel_id: String(channel_id), user_id: senderId }).first();
      if (!isMember) return res.status(403).json({ error: 'No sos miembro de este canal' });
    }

    if (!content?.trim() && !file_url) {
      return res.status(400).json({ error: 'Mensaje vacío' });
    }

    const id = uuidv4();
    await db('chat_messages').insert({ id, sender_id: senderId, receiver_id: receiver_id || null, channel_id: channel_id || null, type, content: content || '', file_url: file_url || null, file_type: file_type || null, file_name: file_name || null, client_id: (type === 'dm' && client_id) ? client_id : null });
    const msg = await db('chat_messages as m').join('users as u', 'm.sender_id', 'u.id').where('m.id', id).select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color').first();
    if (type === 'dm' && receiver_id) {
      io.to(`user:${senderId}`).to(`user:${receiver_id}`).emit('chat:message', msg);
      await createNotification({ userId: receiver_id, type: 'chat', actorId: senderId, chatMessageId: id, preview: content?.slice(0, 80) });
    } else if (type === 'channel' && channel_id) {
      const members = await db('chat_channel_members').where({ channel_id }).pluck('user_id');
      for (const uid of members) {
        io.to(`user:${uid}`).emit('chat:message', msg);
        await createNotification({ userId: uid, type: 'chat', actorId: senderId, chatMessageId: id, preview: content?.slice(0, 80) });
      }
    }
    res.json(msg);
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// POST upload file for chat
const ALLOWED_CHAT_TYPES = /^(image\/(jpeg|png|gif|webp|svg\+xml)|video\/(mp4|webm|quicktime|x-msvideo)|audio\/(mpeg|wav|ogg|webm|mp4)|application\/pdf|text\/plain)$/;
const chatUpload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_CHAT_TYPES.test(file.mimetype)) cb(null, true);
    else cb(new Error('INVALID_FILE_TYPE'));
  }
});

app.post('/api/chat/upload', auth, (req, res) => {
  chatUpload.single('file')(req, res, (err) => {
    if (err && err.message === 'INVALID_FILE_TYPE') {
      return res.status(400).json({ error: 'Tipo de archivo no permitido. Se aceptan imágenes, videos, audios, PDFs y texto.' });
    }
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Archivo demasiado grande (máx. 3GB)' });
      }
      return res.status(400).json({ error: err.message || 'Error al subir archivo' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No se recibió ningún archivo' });
    }
    res.json({
      url: `/uploads/${req.file.filename}`,
      name: req.file.originalname,
      type: req.file.mimetype,
      size: req.file.size
    });
  });
});

// POST create channel (admin only)
app.post('/api/chat/channels', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, members } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'El nombre del canal es obligatorio' });

    const id = uuidv4();
    await db('chat_channels').insert({ id, name: name.trim(), created_by: req.user.id });

    // Always add admin
    await db('chat_channel_members').insert({ channel_id: id, user_id: req.user.id });

    if (members?.length) {
      const otherMembers = members.filter(uid => uid !== req.user.id);
      if (otherMembers.length > 0) {
        await db('chat_channel_members').insert(otherMembers.map(uid => ({ channel_id: id, user_id: uid })));
      }
    }

    const totalMembers = (members?.filter(uid => uid !== req.user.id).length || 0) + 1;
    res.json({ id, name: name.trim(), member_count: totalMembers, created_by: req.user.id });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno del servidor' }); }
});

// ─── SOCKET.IO ───────────────────────────────────────────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('No token'));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    socket.userId = decoded.id;
    socket.userRole = decoded.role;
    next();
  } catch {
    next(new Error('Token inválido'));
  }
});

const onlineUsers = new Map();
io.on('connection', (socket) => {
  socket.on('user:online', () => {
    onlineUsers.set(socket.userId, socket.id);
    socket.join(`user:${socket.userId}`);
    if (socket.userRole === 'admin') socket.join('admins');
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
  socket.on('project:join', async (projectId) => {
    if (!projectId) return;
    const allowed = await isProjectMember(socket.userId, socket.userRole, projectId);
    if (!allowed) return;
    socket.join(`project:${projectId}`);
  });
  socket.on('message:send', async (data) => {
    const { project_id, content, type } = data;
    if (!project_id || !content?.trim()) return;
    const sender = await db('users').where({ id: socket.userId }).first();
    if (!sender) return;
    const allowed = await isProjectMember(socket.userId, socket.userRole, project_id);
    if (!allowed) return;
    const id = uuidv4();
    await db('messages').insert({ id, project_id, sender_id: socket.userId, receiver_id: null, content, type: type || 'project' });
    const msg = { id, project_id, sender_id: socket.userId, receiver_id: null, content, type, sender_name: sender.name, sender_color: sender.avatar_color, created_at: new Date().toISOString() };
    io.to(`project:${project_id}`).emit('message:new', msg);
  });
  socket.on('disconnect', () => {
    for (const [userId, sid] of onlineUsers.entries()) {
      if (sid === socket.id) { onlineUsers.delete(userId); break; }
    }
    io.emit('users:online', Array.from(onlineUsers.keys()));
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

initDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 AgencyOS corriendo en http://localhost:${PORT}`);
    console.log(`👤 Admin: admin@agencyos.com / admin123\n`);
  });
}).catch(e => { console.error('Error iniciando DB:', e); process.exit(1); });
