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
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido' }); }
};

// ─── AUTH ────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await db('users').where({ email }).first();
    if (!user || !bcrypt.compareSync(password, user.password))
      return res.status(401).json({ error: 'Credenciales inválidas' });
    const token = jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, avatar_color: user.avatar_color } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/register', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, email, password, role } = req.body;
    const exists = await db('users').where({ email }).first();
    if (exists) return res.status(400).json({ error: 'Email ya registrado' });
    const hash = bcrypt.hashSync(password, 10);
    const colors = ['#6366f1','#ec4899','#10b981','#f59e0b','#3b82f6','#8b5cf6','#ef4444','#14b8a6'];
    const color = colors[Math.floor(Math.random() * colors.length)];
    await db('users').insert({ id: uuidv4(), name, email, password: hash, role: role || 'editor', avatar_color: color });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/users', auth, async (req, res) => {
  const users = await db('users').select('id','name','email','role','avatar_color','created_at');
  res.json(users);
});

app.delete('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const uid = req.params.id;
    await db('notifications').where({ user_id: uid }).orWhere({ actor_id: uid }).delete();
    await db('messages').where({ sender_id: uid }).delete();
    await db('chat_messages').where({ sender_id: uid }).delete();
    await db('chat_channel_members').where({ user_id: uid }).delete();
    await db('tasks').where({ assigned_to: uid }).update({ assigned_to: null });
    await db('video_comments').where({ user_id: uid }).delete();
    await db('comment_replies').where({ user_id: uid }).delete();
    await db('users').where({ id: uid }).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /api/users/:id — editar usuario (admin, o el propio usuario)
app.patch('/api/users/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'Sin acceso' });
    }
    const { name, email, role, avatar_color, password } = req.body;
    const updateData = {};
    if (name) updateData.name = name;
    if (email) {
      const existing = await db('users').where({ email }).whereNot({ id: req.params.id }).first();
      if (existing) return res.status(400).json({ error: 'Email ya en uso por otro usuario' });
      updateData.email = email;
    }
    if (role && req.user.role === 'admin') updateData.role = role;
    if (avatar_color) updateData.avatar_color = avatar_color;
    if (password) {
      if (password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
      updateData.password = bcrypt.hashSync(password, 10);
    }
    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No hay campos para actualizar' });
    }
    await db('users').where({ id: req.params.id }).update(updateData);
    const updated = await db('users').where({ id: req.params.id }).select('id', 'name', 'email', 'role', 'avatar_color', 'created_at').first();
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PROJECTS ────────────────────────────────────────────────────────────────
app.get('/api/projects', auth, async (req, res) => {
  try {
    const projects = await db('projects as p')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .select('p.*', 'c.name as client_name', 'c.color as client_color')
      .orderBy('p.created_at', 'desc');
    const withCounts = await Promise.all(projects.map(async p => {
      const [{ count: task_count }] = await db('tasks').where({ project_id: p.id }).count('id as count');
      const [{ count: done_count }] = await db('tasks').where({ project_id: p.id, status: 'done' }).count('id as count');
      return { ...p, task_count: Number(task_count), done_count: Number(done_count) };
    }));
    res.json(withCounts);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/projects/:id', auth, async (req, res) => {
  try {
    const project = await db('projects as p')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .where('p.id', req.params.id)
      .select('p.*', 'c.name as client_name', 'c.color as client_color')
      .first();
    if (!project) return res.status(404).json({ error: 'No encontrado' });
    res.json(project);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects', auth, async (req, res) => {
  try {
    const { name, description, color, payment_editor_id, payment_type, payment_amount, payment_hours, client_id, deadline } = req.body;
    const id = uuidv4();
    await db('projects').insert({
      id, name, description, color: color || '#6366f1', created_by: req.user.id,
      client_id: client_id || null,
      deadline: deadline || null,
      payment_editor_id: payment_editor_id || null,
      payment_type: payment_type || 'fixed',
      payment_amount: parseFloat(payment_amount) || 0,
      payment_hours: parseFloat(payment_hours) || 0,
      payment_status: 'unpaid',
      upwork_status: 'pending'
    });
    const project = await db('projects').where({ id }).first();
    io.emit('project:created', project);
    res.json(project);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/projects/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, description, color, status, payment_editor_id, payment_type, payment_amount, payment_hours, payment_status, upwork_status, client_id, deadline } = req.body;
    await db('projects').where({ id: req.params.id }).update({
      name, description, color, status,
      client_id: client_id || null,
      deadline: deadline || null,
      payment_editor_id: payment_editor_id || null,
      payment_type, payment_amount, payment_hours, payment_status, upwork_status
    });
    const project = await db('projects as p').leftJoin('clients as c', 'p.client_id', 'c.id').where('p.id', req.params.id).select('p.*', 'c.name as client_name', 'c.color as client_color').first();
    io.emit('project:updated', project);
    res.json(project);
  } catch (e) { res.status(500).json({ error: e.message }); }
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

    await db('projects').where({ id: projectId }).delete();
    io.emit('project:deleted', { id: projectId });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

app.get('/api/clients', auth, async (req, res) => {
  try {
    const clients = await db('clients').orderBy('name', 'asc');
    res.json(clients);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/clients', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, color, email, phone, notes } = req.body;
    const id = uuidv4();
    await db('clients').insert({ id, name, color: color || '#6366f1', email: email || null, phone: phone || null, notes: notes || null });
    const client = await db('clients').where({ id }).first();
    res.json(client);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/clients/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { name, color, email, phone, notes } = req.body;
    await db('clients').where({ id: req.params.id }).update({ name, color, email, phone, notes });
    const client = await db('clients').where({ id: req.params.id }).first();
    res.json(client);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/clients/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    await db('projects').where({ client_id: req.params.id }).update({ client_id: null });
    await db('clients').where({ id: req.params.id }).delete();
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PAYMENTS ────────────────────────────────────────────────────────────────
app.get('/api/payments', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const projects = await db('projects as p')
      .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .whereNotNull('p.payment_editor_id')
      .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
      .orderBy('p.created_at', 'desc');
    res.json(projects);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/payments/:projectId', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Sin acceso' });
    const { payment_hours, payment_status, upwork_status, payment_amount } = req.body;
    const update = {};
    if (payment_hours !== undefined) update.payment_hours = parseFloat(payment_hours) || 0;
    if (payment_status !== undefined) update.payment_status = payment_status;
    if (upwork_status !== undefined) update.upwork_status = upwork_status;
    if (payment_amount !== undefined) update.payment_amount = parseFloat(payment_amount) || 0;
    if (req.body.editor_paid !== undefined) update.editor_paid = req.body.editor_paid;
    if (req.body.client_paid !== undefined) update.client_paid = req.body.client_paid;
    await db('projects').where({ id: req.params.projectId }).update(update);
    const project = await db('projects as p')
      .leftJoin('users as u', 'p.payment_editor_id', 'u.id')
      .leftJoin('clients as c', 'p.client_id', 'c.id')
      .where('p.id', req.params.projectId)
      .select('p.*', 'u.name as editor_name', 'u.avatar_color as editor_color', 'c.name as client_name', 'c.color as client_color', 'c.email as client_email')
      .first();
    io.emit('payment:updated', project);
    res.json(project);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── TASKS ───────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/tasks', auth, async (req, res) => {
  try {
    const tasks = await db('tasks as t')
      .leftJoin('users as u', 't.assigned_to', 'u.id')
      .where('t.project_id', req.params.projectId)
      .select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color')
      .orderBy('t.created_at', 'asc');
    res.json(tasks);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/projects/:projectId/tasks', auth, async (req, res) => {
  try {
    const { title, description, status, priority, assigned_to, due_date } = req.body;
    const id = uuidv4();
    await db('tasks').insert({ id, project_id: req.params.projectId, title, description, status: status || 'todo', priority: priority || 'medium', assigned_to: assigned_to || null, created_by: req.user.id, due_date: due_date || null });
    const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
    io.emit('task:created', task);
    res.json(task);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/tasks/:id', auth, async (req, res) => {
  try {
    const { title, description, status, priority, assigned_to, due_date } = req.body;
    await db('tasks').where({ id: req.params.id }).update({ title, description, status, priority, assigned_to: assigned_to || null, due_date: due_date || null, updated_at: new Date().toISOString() });
    const task = await db('tasks as t').leftJoin('users as u', 't.assigned_to', 'u.id').where('t.id', req.params.id).select('t.*', 'u.name as assignee_name', 'u.avatar_color as assignee_color').first();
    io.emit('task:updated', task);
    res.json(task);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/tasks/:id', auth, async (req, res) => {
  await db('tasks').where({ id: req.params.id }).delete();
  io.emit('task:deleted', { id: req.params.id });
  res.json({ success: true });
});

// ─── MESSAGES ────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/messages', auth, async (req, res) => {
  const messages = await db('messages as m').join('users as u', 'm.sender_id', 'u.id')
    .where({ 'project_id': req.params.projectId, 'type': 'project' })
    .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color')
    .orderBy('m.created_at', 'asc').limit(200);
  res.json(messages);
});

// ─── VIDEOS ──────────────────────────────────────────────────────────────────
app.get('/api/projects/:projectId/videos', auth, async (req, res) => {
  const videos = await db('videos as v').leftJoin('users as u', 'v.uploaded_by', 'u.id')
    .where('v.project_id', req.params.projectId)
    .select('v.*', 'u.name as uploader_name')
    .orderBy('v.created_at', 'desc');
  res.json(videos);
});

app.post('/api/projects/:projectId/videos', auth, upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const { title, version } = req.body;
  const id = uuidv4();
  await db('videos').insert({ id, project_id: req.params.projectId, title: title || req.file.originalname, filename: req.file.filename, original_name: req.file.originalname, version: parseInt(version) || 1, uploaded_by: req.user.id, file_size: req.file.size });
  const video = await db('videos as v').leftJoin('users as u', 'v.uploaded_by', 'u.id').where('v.id', id).select('v.*', 'u.name as uploader_name').first();
  io.emit('video:uploaded', video);
  // Check storage after upload
  const bytes = getUploadsSize();
  if (bytes >= STORAGE_WARN_BYTES) {
    const admins = await db('users').where({ role: 'admin' }).pluck('id');
    admins.forEach(adminId => io.to(`user:${adminId}`).emit('storage:warning', { bytes, gb: (bytes / (1024 ** 3)).toFixed(2) }));
  }
  res.json(video);
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
        await db('comment_attachments').whereIn('comment_id', commentIds).delete();
        await db('comment_replies').whereIn('comment_id', commentIds).delete();
      }
      await db('video_comments').where({ video_id: req.params.id }).delete();
    }
    await db('videos').where({ id: req.params.id }).delete();
    io.emit('video:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── STORAGE CHECK ───────────────────────────────────────────────────────────

const STORAGE_WARN_BYTES = 20 * 1024 * 1024 * 1024; // 20GB

function getUploadsSize(dir = uploadsDir) {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) total += getUploadsSize(fullPath);
      else total += fs.statSync(fullPath).size;
    } catch {}
  }
  return total;
}

app.get('/api/storage', auth, async (req, res) => {
  const bytes = getUploadsSize();
  res.json({ bytes, gb: (bytes / (1024 ** 3)).toFixed(2), warning: bytes >= STORAGE_WARN_BYTES });
});

// ─── VIDEO COMMENTS ──────────────────────────────────────────────────────────
app.get('/api/videos/:videoId/comments', auth, async (req, res) => {
  const comments = await db('video_comments as vc').join('users as u', 'vc.user_id', 'u.id')
    .where('vc.video_id', req.params.videoId)
    .select('vc.*', 'u.name as user_name', 'u.avatar_color')
    .orderBy('vc.timestamp_sec', 'asc');
  const withAttachments = await Promise.all(comments.map(async c => ({
    ...c,
    attachments: await db('comment_attachments').where({ comment_id: c.id }),
    replies: await db('comment_replies as r').join('users as u', 'r.user_id', 'u.id').where('r.comment_id', c.id).select('r.*', 'u.name as user_name', 'u.avatar_color').orderBy('r.created_at', 'asc'),
    annotation: c.annotation ? JSON.parse(c.annotation) : null
  })));
  res.json(withAttachments);
});

app.post('/api/videos/:videoId/comments', auth, upload.array('attachments', 5), async (req, res) => {
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
  io.emit('comment:created', full);
  // Notify admins and users who already commented on this video, except sender
  const video = await db('videos').where({ id: req.params.videoId }).first();
  if (video) {
    const members = await db('users')
      .where('id', '!=', req.user.id)
      .where(function() {
        this.where({ role: 'admin' })
          .orWhereIn('id', db('video_comments').where({ video_id: req.params.videoId }).pluck('user_id'));
      });
    for (const m of members) {
      await createNotification({ userId: m.id, type: 'comment', actorId: req.user.id, projectId: video.project_id, videoId: video.id, commentId: id, preview: content?.slice(0, 80) });
    }
  }
  res.json(full);
});

app.patch('/api/comments/:id/resolve', auth, async (req, res) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
    const resolved = !comment.resolved;
    await db('video_comments').where({ id: req.params.id }).update({ resolved });
    io.emit('comment:resolved', { id: req.params.id, resolved });
    res.json({ id: req.params.id, resolved });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/comments/:id', auth, async (req, res) => {
  try {
    const comment = await db('video_comments').where({ id: req.params.id }).first();
    if (!comment) return res.status(404).json({ error: 'No encontrado' });
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
    io.emit('comment:deleted', { id: req.params.id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET replies for a comment
app.get('/api/comments/:id/replies', auth, async (req, res) => {
  try {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST create reply
app.post('/api/comments/:id/replies', auth, upload.array('attachments', 5), async (req, res) => {
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
    io.emit('comment:reply', full);
    const parentComment = await db('video_comments').where({ id: req.params.id }).first();
    if (parentComment) {
      const video = await db('videos').where({ id: parentComment.video_id }).first();
      await createNotification({ userId: parentComment.user_id, type: 'reply', actorId: req.user.id, projectId: video?.project_id, videoId: parentComment.video_id, commentId: req.params.id, preview: content?.slice(0, 80) });
    }
    res.json(full);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── NOTIFICATIONS ────────────────────────────────────────────────────────────

async function createNotification({ userId, type, actorId, projectId, videoId, commentId, chatMessageId, preview }) {
  if (userId === actorId) return; // don't notify yourself
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    const msgs = await db('chat_messages')
      .whereNot({ sender_id: userId })
      .select('id', 'type', 'sender_id', 'receiver_id', 'channel_id', 'read_by');

    const counts = {};
    for (const m of msgs) {
      if (m.type === 'dm' && m.receiver_id !== userId) continue;
      if (m.type === 'channel') {
        const isMember = await db('chat_channel_members').where({ channel_id: m.channel_id, user_id: userId }).first();
        if (!isMember) continue;
      }
      const readBy = parseReadBy(m.read_by);
      if (readBy.includes(userId)) continue;
      const key = m.type === 'dm' ? `dm:${m.sender_id}` : `channel:${m.channel_id}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    res.json(counts);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── CHAT ─────────────────────────────────────────────────────────────────────

// GET conversations list for current user
app.get('/api/chat/conversations', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const isAdmin = req.user.role === 'admin';

    let dms = [];
    if (isAdmin) {
      // Admin sees all users they've chatted with OR all editors
      const allUsers = await db('users').where('id', '!=', userId).select('id', 'name', 'avatar_color');
      dms = await Promise.all(allUsers.map(async u => {
        const last = await db('chat_messages')
          .where(function() { this.where({ sender_id: userId, receiver_id: u.id, type: 'dm' }).orWhere({ sender_id: u.id, receiver_id: userId, type: 'dm' }); })
          .orderBy('created_at', 'desc').first();
        return { id: u.id, name: u.name, color: u.avatar_color, last_message: last?.content || (last?.file_type ? '📎 Archivo' : null), unread: 0 };
      }));
    } else {
      // Editor: ve a TODOS los admins (no solo el primero)
      const admins = await db('users').where({ role: 'admin' }).select('id', 'name', 'avatar_color');
      dms = await Promise.all(admins.map(async (admin) => {
        const last = await db('chat_messages')
          .where(function() { this.where({ sender_id: userId, receiver_id: admin.id, type: 'dm' }).orWhere({ sender_id: admin.id, receiver_id: userId, type: 'dm' }); })
          .orderBy('created_at', 'desc').first();
        return { id: admin.id, name: admin.name, color: admin.avatar_color, last_message: last?.content || (last?.file_type ? '📎 Archivo' : null), unread: 0 };
      }));
    }

    // Channels: admin sees all, editor only sees ones they're member of
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
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET messages for a DM or channel
app.get('/api/chat/messages', auth, async (req, res) => {
  try {
    const { type, id } = req.query;
    const userId = req.user.id;

    let msgs = [];
    if (type === 'dm') {
      // Security: only participants can read
      msgs = await db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .where('m.type', 'dm')
        .where(function() { this.where({ sender_id: userId, receiver_id: id }).orWhere({ sender_id: id, receiver_id: userId }); })
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color')
        .orderBy('m.created_at', 'asc').limit(200);
    } else if (type === 'channel') {
      // Security: check membership (admin always allowed)
      if (req.user.role !== 'admin') {
        const isMember = await db('chat_channel_members').where({ channel_id: id, user_id: userId }).first();
        if (!isMember) return res.status(403).json({ error: 'Sin acceso' });
      }
      msgs = await db('chat_messages as m')
        .join('users as u', 'm.sender_id', 'u.id')
        .where({ 'm.type': 'channel', 'm.channel_id': id })
        .select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color')
        .orderBy('m.created_at', 'asc').limit(200);
    }
    res.json(msgs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST send a message
app.post('/api/chat/messages', auth, async (req, res) => {
  try {
    const { type, receiver_id, channel_id, content, file_url, file_type, file_name } = req.body;
    const senderId = req.user.id;

    // Security: editors can only DM admins (any admin, not just the first one)
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
    await db('chat_messages').insert({ id, sender_id: senderId, receiver_id: receiver_id || null, channel_id: channel_id || null, type, content: content || '', file_url: file_url || null, file_type: file_type || null, file_name: file_name || null });
    const msg = await db('chat_messages as m').join('users as u', 'm.sender_id', 'u.id').where('m.id', id).select('m.*', 'u.name as sender_name', 'u.avatar_color as sender_color').first();
    io.emit('chat:message', msg);
    // Notify recipient(s)
    if (type === 'dm' && receiver_id) {
      await createNotification({ userId: receiver_id, type: 'chat', actorId: senderId, chatMessageId: id, preview: content?.slice(0, 80) });
    } else if (type === 'channel' && channel_id) {
      const members = await db('chat_channel_members').where({ channel_id }).pluck('user_id');
      for (const uid of members) {
        await createNotification({ userId: uid, type: 'chat', actorId: senderId, chatMessageId: id, preview: content?.slice(0, 80) });
      }
    }
    res.json(msg);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST upload file for chat
app.post('/api/chat/upload', auth, (req, res) => {
  upload.single('file')(req, res, (err) => {
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
  } catch (e) { res.status(500).json({ error: e.message }); }
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
    socket.join(`user:${socket.userId}`); // personal room for notifications
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
  socket.on('message:send', async (data) => {
    const { project_id, receiver_id, content, type } = data;
    const sender = await db('users').where({ id: socket.userId }).first();
    if (!sender) return;
    const id = uuidv4();
    await db('messages').insert({ id, project_id: project_id || null, sender_id: socket.userId, receiver_id: receiver_id || null, content, type: type || 'project' });
    const msg = { id, project_id, sender_id: socket.userId, receiver_id, content, type, sender_name: sender.name, sender_color: sender.avatar_color, created_at: new Date().toISOString() };
    io.emit('message:new', msg);
  });
  socket.on('disconnect', () => {
    for (const [userId, sid] of onlineUsers.entries()) {
      if (sid === socket.id) { onlineUsers.delete(userId); break; }
    }
    io.emit('users:online', Array.from(onlineUsers.keys()));
  });
});

// ─── CLIENT ESTÁTICO (producción) ────────────────────────────────────────────
// Si existe client/dist (build de Vite), servirlo y resolver el SPA fallback.
// En desarrollo esa carpeta no existe, así que esto no afecta el flujo local con Vite.
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
