// SpoolBase backend — API key-value persistente su SQLite
// GET/POST /api/data/:key mirroring la semantica di localStorage

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
function notifyTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: message })
  }).catch(err => console.error('notifyTelegram fallita:', err.message));
}


const PORT = process.env.PORT || 3001;
// Bind solo su localhost: nginx fa da reverse proxy, il servizio
// non è mai raggiungibile direttamente da internet.
const HOST = process.env.HOST || '127.0.0.1';
// Modalita' utente singolo: nessuna API key, tutto attribuito all'admin.
const SINGLE_USER = process.env.SINGLE_USER === '1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'spoolbase.db');
// Autenticazione multi-utente: ogni utente ha la propria X-API-Key,
// mappata a un user_id nella tabella "users". Nessun segreto server-side
// per utente: la chiave viene generata una volta e consegnata via wizard.

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS kv_store (
    user_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS print_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    printer TEXT,
    event_name TEXT NOT NULL,
    filename TEXT,
    filament_used REAL,
    print_duration REAL,
    state TEXT,
    message TEXT,
    reviewed INTEGER NOT NULL DEFAULT 0,
    user_id TEXT NOT NULL DEFAULT 'admin'
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    password_hash TEXT,
    role TEXT NOT NULL DEFAULT 'user'
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_codes (
    code TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS signup_requests (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    reviewed_at TEXT,
    reviewed_by TEXT
  );

  CREATE TABLE IF NOT EXISTS activation_tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    purpose TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );
`);

// Bootstrap: su un'istanza nuova (nessun utente) crea automaticamente il
// primo admin e stampa la sua API key una sola volta sulla console. Senza
// questo, nessuno potrebbe mai registrare un utente: ogni approvazione
// richiede gia' un admin esistente (vedi requireAdmin piu' sotto).
(function bootstrapFirstAdmin() {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount > 0 || SINGLE_USER) return;
  const adminId = process.env.BOOTSTRAP_ADMIN_ID || 'admin';
  const adminName = process.env.BOOTSTRAP_ADMIN_NAME || 'Admin';
  const apiKey = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO users (id, name, api_key, created_at, role) VALUES (?, ?, ?, datetime('now'), 'admin')").run(adminId, adminName, apiKey);
  console.log('');
  console.log('========================================================');
  console.log(' Nessun utente trovato: creato il primo utente admin.');
  console.log(` Username: ${adminId}`);
  console.log(` API key:  ${apiKey}`);
  console.log(' Usa questa chiave per il primo accesso al frontend, poi');
  console.log(' imposta una password da /api/auth/set-password. Questa');
  console.log(' chiave non verra piu mostrata.');
  console.log('========================================================');
  console.log('');
})();

// In SINGLE_USER l'admin esiste sempre (creato senza stampare chiavi).
let SINGLE_USER_ID = null;
if (SINGLE_USER) {
  const adm = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").get();
  if (adm) SINGLE_USER_ID = adm.id;
  else {
    SINGLE_USER_ID = process.env.BOOTSTRAP_ADMIN_ID || 'admin';
    db.prepare("INSERT INTO users (id, name, api_key, created_at, role) VALUES (?, ?, ?, datetime('now'), 'admin')")
      .run(SINGLE_USER_ID, process.env.BOOTSTRAP_ADMIN_NAME || 'Admin', crypto.randomBytes(32).toString('hex'));
  }
}

const app = express();
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '10mb' }));

// Rate limiting su endpoint di autenticazione (aperti a internet dopo rimozione Cloudflare Access)
const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 15, standardHeaders: true, legacyHeaders: false, message: { error: 'troppi tentativi, riprova tra qualche minuto' } });
const signupLimiter = rateLimit({ windowMs: 60*60*1000, max: 5, standardHeaders: true, legacyHeaders: false, message: { error: 'troppe richieste di registrazione, riprova piu tardi' } });


// Log minimale per debug iniziale
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
  if(req.method==='POST'){
    if(req.body && Object.keys(req.body).length){
      const SENSITIVE = ['password','api_key','apiKey','token'];
      const safeBody = {...req.body};
      for(const k of SENSITIVE){ if(k in safeBody) safeBody[k] = '***'; }
      console.log('  body: '+JSON.stringify(safeBody));
    }
  }
  next();
});

// Middleware: richiede sempre X-API-Key, la risolve a un utente specifico
// e imposta req.userId. Ogni richiesta è quindi ambito a un solo utente.
function checkApiKey(req, res, next) {
  if (SINGLE_USER) { req.userId = SINGLE_USER_ID; return next(); }
  const provided = req.get('X-API-Key');
  if (!provided) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  let user = db.prepare('SELECT id FROM users WHERE api_key = ?').get(provided);
  if (!user) {
    const session = db.prepare("SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')").get(provided);
    if (session) user = { id: session.user_id };
  }
  if (!user) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  req.userId = user.id;
  next();
}

const SESSION_TTL_SQL = "+30 days";
const DEVICE_CODE_TTL_SQL = "+5 minutes";
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;
const SERVER_LAN_IP = process.env.SERVER_LAN_IP || '';

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, datetime('now'), datetime('now', ?))").run(token, userId, SESSION_TTL_SQL);
  return token;
}

// Login con username+password: restituisce un token di sessione utilizzabile
// esattamente come la vecchia chiave API (stesso header X-API-Key).
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'credenziali_mancanti' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(String(username).trim());
  if (!user || !user.password_hash || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: 'credenziali_errate' });
  }
  const token = createSession(user.id);
  res.json({ token, name: user.name });
});

// Frontend: solo frontend.html (nessun altro file della cartella viene servito).
// In SINGLE_USER viene iniettato un flag che disattiva la richiesta della chiave.
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'frontend.html'), 'utf8');
  if (SINGLE_USER) html = html.replace('<head>', '<head><script>window.SPOOLBASE_SINGLE_USER=true;</script>');
  res.type('html').send(html);
});

app.post('/api/auth/logout', checkApiKey, (req, res) => {
  const provided = req.get('X-API-Key');
  db.prepare('DELETE FROM sessions WHERE token = ?').run(provided);
  res.json({ ok: true });
});

// Permette a un utente già autenticato (via chiave API o sessione) di impostare
// una password personale, cosi' da poter fare login anche da altri dispositivi
// senza dover ricopiare la chiave lunga.
app.post('/api/auth/set-password', checkApiKey, (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'password_troppo_corta' });
  }
  const hash = bcrypt.hashSync(String(password), 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.userId);
  res.json({ ok: true });
});

// Genera un codice monouso (valido 5 minuti) e il relativo QR: un dispositivo
// gia' autenticato lo crea, un dispositivo nuovo lo scansiona e riceve una sessione.
app.post('/api/auth/device-code', checkApiKey, async (req, res) => {
  const code = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO device_codes (code, user_id, created_at, expires_at, consumed) VALUES (?, ?, datetime('now'), datetime('now', ?), 0)").run(code, req.userId, DEVICE_CODE_TTL_SQL);
  const url = PUBLIC_BASE_URL + '/?device_code=' + code;
  try {
    const qrDataUrl = await QRCode.toDataURL(url, { width: 300, margin: 1 });
    res.json({ code, expires_in: 300, qr_data_url: qrDataUrl });
  } catch (e) {
    res.status(500).json({ error: 'qr_generation_failed' });
  }
});

app.post('/api/auth/device-code/claim', (req, res) => {
  const { code } = req.body || {};
  if (!code) return res.status(400).json({ error: 'code_required' });
  const row = db.prepare("SELECT * FROM device_codes WHERE code = ? AND consumed = 0 AND expires_at > datetime('now')").get(code);
  if (!row) {
    return res.status(400).json({ error: 'code_invalid_or_expired' });
  }
  db.prepare('UPDATE device_codes SET consumed = 1 WHERE code = ?').run(code);
  const token = createSession(row.user_id);
  const user = db.prepare('SELECT name FROM users WHERE id = ?').get(row.user_id);
  res.json({ token, name: user ? user.name : row.user_id });
});


// --- Registrazione self-service con approvazione manuale ---

function generateActivationToken(userId, purpose, ttlSql) {
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO activation_tokens (token, user_id, purpose, created_at, expires_at, consumed) VALUES (?, ?, ?, datetime('now'), datetime('now', ?), 0)").run(token, userId, purpose, ttlSql);
  return token;
}

function requireAdmin(req, res, next) {
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ error: 'accesso_negato' });
  }
  next();
}

app.post('/api/auth/signup-request', signupLimiter, (req, res) => {
  const { username, name } = req.body || {};
  const cleanUsername = String(username || '').trim().toLowerCase();
  const cleanName = String(name || '').trim();
  if (!cleanUsername || !cleanName) {
    return res.status(400).json({ error: 'dati_mancanti' });
  }
  if (!/^[a-z0-9_-]{3,32}$/.test(cleanUsername)) {
    return res.status(400).json({ error: 'username_non_valido' });
  }
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get(cleanUsername);
  if (existingUser) {
    return res.status(409).json({ error: 'username_gia_in_uso' });
  }
  const existingRequest = db.prepare("SELECT id FROM signup_requests WHERE username = ? AND status = 'pending'").get(cleanUsername);
  if (existingRequest) {
    return res.status(409).json({ error: 'richiesta_gia_in_corso' });
  }
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare("INSERT INTO signup_requests (id, username, name, status, created_at) VALUES (?, ?, ?, 'pending', datetime('now'))").run(id, cleanUsername, cleanName);
  notifyTelegram(`\u{1F514} Nuova richiesta di accesso SpoolBase\nUtente: ${cleanUsername}\nNome: ${cleanName}\nApprova dal pannello admin.`);
  res.json({ ok: true });
});

app.post('/api/auth/activate', authLimiter, (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token_mancante' });
  const row = db.prepare("SELECT * FROM activation_tokens WHERE token = ? AND consumed = 0 AND expires_at > datetime('now')").get(token);
  if (!row) return res.status(400).json({ error: 'token_non_valido_o_scaduto' });
  db.prepare('UPDATE activation_tokens SET consumed = 1 WHERE token = ?').run(token);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
  if (!user) return res.status(404).json({ error: 'utente_non_trovato' });
  const sessionToken = createSession(user.id);
  res.json({ token: sessionToken, name: user.name, needsPassword: !user.password_hash });
});

app.get('/api/admin/signup-requests', checkApiKey, requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT id, username, name, created_at FROM signup_requests WHERE status = 'pending' ORDER BY created_at ASC").all();
  res.json(rows);
});

app.post('/api/admin/signup-requests/:id/approve', checkApiKey, requireAdmin, (req, res) => {
  const request = db.prepare("SELECT * FROM signup_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'richiesta_non_trovata' });
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get(request.username);
  if (existingUser) {
    db.prepare("UPDATE signup_requests SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?").run(req.userId, request.id);
    return res.status(409).json({ error: 'username_gia_in_uso' });
  }
  const apiKey = crypto.randomBytes(32).toString('hex');
  db.prepare("INSERT INTO users (id, name, api_key, created_at, role) VALUES (?, ?, ?, datetime('now'), 'user')").run(request.username, request.name, apiKey);
  db.prepare("UPDATE signup_requests SET status = 'approved', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?").run(req.userId, request.id);
  const activationToken = generateActivationToken(request.username, 'activation', '+7 days');
  const url = PUBLIC_BASE_URL + '/?activation_token=' + activationToken;
  res.json({ ok: true, activationUrl: url });
});

app.post('/api/admin/signup-requests/:id/reject', checkApiKey, requireAdmin, (req, res) => {
  const request = db.prepare("SELECT * FROM signup_requests WHERE id = ? AND status = 'pending'").get(req.params.id);
  if (!request) return res.status(404).json({ error: 'richiesta_non_trovata' });
  db.prepare("UPDATE signup_requests SET status = 'rejected', reviewed_at = datetime('now'), reviewed_by = ? WHERE id = ?").run(req.userId, request.id);
  res.json({ ok: true });
});

app.get('/api/admin/users', checkApiKey, requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT id, name, role, created_at, (password_hash IS NOT NULL) AS has_password FROM users ORDER BY created_at ASC').all();
  res.json(rows);
});

app.post('/api/admin/users/:id/reset-link', checkApiKey, requireAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'utente_non_trovato' });
  db.prepare('UPDATE users SET password_hash = NULL WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  const resetToken = generateActivationToken(user.id, 'reset', '+7 days');
  const url = PUBLIC_BASE_URL + '/?activation_token=' + resetToken;
  res.json({ ok: true, activationUrl: url });
});
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/data/:key', checkApiKey, (req, res) => {
  const row = db.prepare('SELECT value, updated_at FROM kv_store WHERE key = ? AND user_id = ?').get(req.params.key, req.userId);
  if (!row) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ key: req.params.key, value: row.value, updated_at: row.updated_at });
});

// Integrazione opzionale: se configurato, notifica un dashboard esterno
// (che gestisce le proprie credenziali Google Calendar) di ogni nuovo ordine.
// Disattivata di default - va abilitata esplicitamente via env var.
const DASHBOARD_CALENDAR_URL = process.env.DASHBOARD_CALENDAR_URL || '';

// Fire-and-forget, non deve mai bloccare o far fallire la creazione
// dell'ordine vero e proprio se il dashboard e' irraggiungibile.
function notifyDashboardNewOrder(order) {
  if (!DASHBOARD_CALENDAR_URL) return;
  const dateStr = order.dataConsegnaPrevista || (order.createdAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const clienteLabel = order.clienteNome ? `${order.clienteNome} - ` : '';
  fetch(DASHBOARD_CALENDAR_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      summary: `Lavoro: ${clienteLabel}${order.descrizione || '(senza descrizione)'}`,
      date: dateStr,
      start_time: '09:00',
      end_time: '10:00',
    }),
  }).catch(err => console.error('notifyDashboardNewOrder fallita:', err.message));
}

app.post('/api/data/:key', checkApiKey, (req, res) => {
  const { value } = req.body;
  if (typeof value !== 'string') {
    return res.status(400).json({ error: 'value_must_be_string' });
  }
  let newOrders = [];
  if (req.params.key === 'ordini_log') {
    try {
      const oldRow = db.prepare('SELECT value FROM kv_store WHERE key = ? AND user_id = ?').get('ordini_log', req.userId);
      const oldIds = new Set((oldRow ? JSON.parse(oldRow.value) : []).map(o => o.id));
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        newOrders = parsed.filter(o => o && o.id && !oldIds.has(o.id));
      }
    } catch (e) {
      console.error('diff ordini_log fallito:', e.message);
    }
  }
  db.prepare(`
    INSERT INTO kv_store (user_id, key, value, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(req.userId, req.params.key, value);
  res.json({ key: req.params.key, saved: true });
  newOrders.forEach(notifyDashboardNewOrder);
});

app.delete('/api/data/:key', checkApiKey, (req, res) => {
  db.prepare('DELETE FROM kv_store WHERE key = ? AND user_id = ?').run(req.params.key, req.userId);
  res.json({ key: req.params.key, deleted: true });
});

// Elenco chiavi presenti (utile per debug/migrazione)
app.get('/api/keys', checkApiKey, (req, res) => {
  const rows = db.prepare('SELECT key, updated_at FROM kv_store WHERE user_id = ? ORDER BY updated_at DESC').all(req.userId);
  res.json(rows);
});
app.post('/api/print-events', checkApiKey, (req, res) => {
  let data = req.body;

  // Il notifier di Moonraker passa attraverso Apprise, che avvolge
  // sempre il payload in {version, title, message, type}. I nostri
  // dati reali sono dentro "message" come stringa JSON.
  if (data && typeof data.message === 'string') {
    try {
      data = JSON.parse(data.message);
    } catch (e) {
      return res.status(400).json({ error: 'invalid_message_json', raw: data.message });
    }
  }

  const { event_name, printer, filename, filament_used, print_duration, state, message: stateMessage } = data || {};

  if (!event_name) {
    return res.status(400).json({ error: 'event_name_required', received: data });
  }

  // La stampante che genera l'evento appartiene a un utente specifico;
  // l'evento va attribuito al proprietario della stampante, non a chi
  // ha presentato la chiave (il notifier Moonraker non è una sessione utente).
  const owner = printer
    ? (db.prepare('SELECT user_id FROM printers WHERE notifier_name = ?').get(printer)
       || db.prepare('SELECT user_id FROM printers WHERE name = ?').get(printer))
    : null;
  const ownerUserId = (owner && owner.user_id) || req.userId;

  const insertInfo = db.prepare(`
    INSERT INTO print_events (timestamp, printer, event_name, filename, filament_used, print_duration, state, message, user_id)
    VALUES (datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    printer || null,
    event_name,
    filename || null,
    filament_used !== null ? Number(filament_used) : null,
    print_duration !== null ? Number(print_duration) : null,
    state || null,
    stateMessage || null,
    ownerUserId
  );

  const newEventId = insertInfo.lastInsertRowid;
  const AUTO_STATES = ['complete', 'error', 'cancelled'];
  if (AUTO_STATES.includes(state) && filename && filament_used) {
    tryAutoConsumeSpool(ownerUserId, printer, filename, Number(filament_used), newEventId).catch(e => console.error('[auto-consumo] errore async:', e.message));
  }

  res.json({ saved: true });
});

app.get('/api/print-events', checkApiKey, (req, res) => {
  const onlyUnreviewed = req.query.all !== 'true';
  const rows = onlyUnreviewed
    ? db.prepare('SELECT * FROM print_events WHERE reviewed = 0 AND user_id = ? ORDER BY id DESC').all(req.userId)
    : db.prepare('SELECT * FROM print_events WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(req.userId);
  res.json(rows);
});

app.post('/api/print-events/:id/review', checkApiKey, (req, res) => {
  const info = db.prepare('UPDATE print_events SET reviewed = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ id: Number(req.params.id), reviewed: true });
});
// --- Fase 3.1/3.2: tabella printers + CRUD ---
// Multi-tenant: ogni riga appartiene a req.userId (risolto da checkApiKey).
db.exec(`
  CREATE TABLE IF NOT EXISTS printers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL DEFAULT 'admin',
    name TEXT NOT NULL,
    ip TEXT,
    model TEXT,
    watt REAL,
    notes TEXT,
    notifier_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_user_name
    ON printers(user_id, name);
`);

// Storico stato stampanti (online/offline) per rilevare downtime prolungati
db.exec(`
  CREATE TABLE IF NOT EXISTS printer_status_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    printer_id INTEGER NOT NULL,
    online INTEGER NOT NULL,
    message TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_printer_status_log_printer
    ON printer_status_log(printer_id, checked_at);
`);

app.get('/api/config', checkApiKey, (req, res) => {
  const me = db.prepare('SELECT role FROM users WHERE id = ?').get(req.userId);
  res.json({ serverLanIp: SERVER_LAN_IP, role: me ? me.role : 'user' });
});

app.get('/api/printers', checkApiKey, (req, res) => {
  const rows = db.prepare('SELECT * FROM printers WHERE user_id = ? ORDER BY name').all(req.userId);
  res.json(rows);
});

app.post('/api/printers', checkApiKey, (req, res) => {
  const { name, ip, model, watt, notes, notifier_name } = req.body || {};
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name_required' });
  }
  if (ip !== undefined && ip !== null && ip !== '' && !isAllowedPrinterIp(ip)) {
    return res.status(400).json({ error: 'ip_non_valido' });
  }
  try {
    const info = db.prepare(
      'INSERT INTO printers (user_id, name, ip, model, watt, notes, notifier_name) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(req.userId, String(name).trim(), ip || null, model || null, watt !== null && watt !== '' ? Number(watt) || 0 : null, notes || null, notifier_name ? String(notifier_name).trim() : null);
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'name_already_exists' });
    }
    throw e;
  }
});

app.put('/api/printers/:id', checkApiKey, (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM printers WHERE id = ? AND user_id = ?').get(id, req.userId);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const { name, ip, model, watt, notes, notifier_name } = req.body || {};
  const newName = name !== undefined ? String(name).trim() : existing.name;
  if (!newName) return res.status(400).json({ error: 'name_required' });
  if (ip !== undefined && ip !== null && ip !== '' && !isAllowedPrinterIp(ip)) {
    return res.status(400).json({ error: 'ip_non_valido' });
  }
  try {
    db.prepare(
      "UPDATE printers SET name = ?, ip = ?, model = ?, watt = ?, notes = ?, notifier_name = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?"
    ).run(
      newName,
      ip !== undefined ? (ip || null) : existing.ip,
      model !== undefined ? (model || null) : existing.model,
      watt !== undefined ? (watt === null || watt === '' ? null : Number(watt) || 0) : existing.watt,
      notes !== undefined ? (notes || null) : existing.notes,
      notifier_name !== undefined ? (notifier_name ? String(notifier_name).trim() : null) : existing.notifier_name,
      id, req.userId
    );
    res.json(db.prepare('SELECT * FROM printers WHERE id = ?').get(id));
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'name_already_exists' });
    }
    throw e;
  }
});

app.delete('/api/printers/:id', checkApiKey, (req, res) => {
  const info = db.prepare('DELETE FROM printers WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.userId);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.json({ deleted: true });
});
// --- fine printers ---

// --- Fase 3b: controllo stampanti via Moonraker (v1.1, stile Fluidd) ---
const MOONRAKER_PORT = 7125;
const MOONRAKER_TIMEOUT_MS = 8000;

async function moonrakerCall(ip, apiPath, method = 'GET', timeoutMs = MOONRAKER_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch('http://' + ip + ':' + MOONRAKER_PORT + apiPath, { method, signal: ctrl.signal, redirect: 'manual' });
    if (!r.ok) throw new Error('Moonraker HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}


// --- Auto-consumo bobina da tag SPOOLBASE_ID nel G-code (Fase 2 roadmap) ---
async function fetchGcodeHeadText(ip, filename, maxBytes) {
  maxBytes = maxBytes || 8192;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), MOONRAKER_TIMEOUT_MS);
  try {
    const url = 'http://' + ip + ':' + MOONRAKER_PORT + '/server/files/gcodes/' + encodeURIComponent(filename);
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'manual', headers: { Range: 'bytes=0-' + (maxBytes - 1) } });
    if (!r.ok && r.status !== 206) throw new Error('Moonraker file HTTP ' + r.status);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

async function tryAutoConsumeSpool(ownerUserId, printerName, filename, filamentUsed, eventId) {
  try {
    if (!ownerUserId || !filename || !filamentUsed || filamentUsed <= 0) return false;
    const printerRow = db.prepare('SELECT ip FROM printers WHERE (notifier_name = ? OR name = ?) AND user_id = ?').get(printerName, printerName, ownerUserId);
    if (!printerRow || !printerRow.ip) return false;

    const head = await fetchGcodeHeadText(printerRow.ip, filename, 8192);
    const m = head.match(/SPOOLBASE_ID\s*[:=]\s*([A-Za-z0-9_-]+)/i);
    if (!m) return false;
    const spoolId = m[1];

    const kv = db.prepare('SELECT value FROM kv_store WHERE key = ? AND user_id = ?').get('spools', ownerUserId);
    if (!kv) return false;
    let spools;
    try { spools = JSON.parse(kv.value); } catch (e) { return false; }
    if (!Array.isArray(spools)) return false;

    const idx = spools.findIndex(s => String(s.id) === String(spoolId));
    if (idx === -1) return false;
    const spool = spools[idx];

    const usedG = Math.min(Number(filamentUsed), Number(spool.pesoRim) || 0);
    spool.pesoRim = Math.max(0, (Number(spool.pesoRim) || 0) - Number(filamentUsed));
    if (spool.stato === 'nuova') spool.stato = 'aperta';
    if (spool.pesoRim <= 0) spool.stato = 'esaurita';

    db.prepare(
      "INSERT INTO kv_store (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(ownerUserId, 'spools', JSON.stringify(spools));

    const clogRow = db.prepare('SELECT value FROM kv_store WHERE key = ? AND user_id = ?').get('consumption_log', ownerUserId);
    let clog = [];
    if (clogRow) { try { clog = JSON.parse(clogRow.value) || []; } catch (e) { clog = []; } }
    const prezzo = Number(spool.prezzo) || 0;
    const pesoTot = Number(spool.pesoTot) || 0;
    const costo = pesoTot ? (prezzo * usedG / pesoTot) : 0;
    clog.push({
      timestamp: new Date().toISOString(),
      spoolId: spool.id,
      materiale: spool.materiale,
      marca: spool.marca || '-',
      coloreNome: spool.coloreNome,
      grammi: usedG,
      costo,
      source: 'stampante-auto',
      orderId: null
    });
    db.prepare(
      "INSERT INTO kv_store (user_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(ownerUserId, 'consumption_log', JSON.stringify(clog));

    if (eventId) {
      db.prepare('UPDATE print_events SET reviewed = 1 WHERE id = ?').run(eventId);
    }

    console.log('[auto-consumo] evento ' + eventId + ': scaricati ' + usedG + 'g dalla bobina ' + spoolId);
    return true;
  } catch (e) {
    console.error('[auto-consumo] errore:', e.message);
    return false;
  }
}
function loadPrinterWithIp(req, res) {
  const p = db.prepare('SELECT * FROM printers WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) { res.status(404).json({ error: 'Stampante non trovata' }); return null; }
  if (!p.ip) { res.status(409).json({ error: 'Stampante senza IP configurato' }); return null; }
  return p;
}

app.get('/api/printers/:id/status', checkApiKey, async (req, res) => {
  const p = loadPrinterWithIp(req, res);
  if (!p) return;
  try {
    const q = await moonrakerCall(p.ip, '/printer/objects/query?print_stats&extruder&heater_bed&display_status&virtual_sdcard&fan&toolhead&gcode_move');
    const s = (q.result && q.result.status) || {};
    const ps = s.print_stats || {};
    res.json({
      online: true,
      state: ps.state || 'unknown',
      filename: ps.filename || null,
      progress: (s.display_status && typeof s.display_status.progress === 'number') ? s.display_status.progress : ((s.virtual_sdcard && s.virtual_sdcard.progress) || 0),
      print_duration: ps.print_duration || 0,
      filament_used: ps.filament_used || 0,
      extruder: { actual: s.extruder ? s.extruder.temperature : null, target: s.extruder ? s.extruder.target : null },
      bed: { actual: s.heater_bed ? s.heater_bed.temperature : null, target: s.heater_bed ? s.heater_bed.target : null },
      fan: s.fan ? s.fan.speed : null,
      speed_factor: (s.gcode_move && s.gcode_move.speed_factor) || 1,
      position: (s.toolhead && s.toolhead.position) ? s.toolhead.position.slice(0, 3) : null,
      homed_axes: (s.toolhead && s.toolhead.homed_axes) || ''
    });
  } catch (e) {
    res.json({ online: false, error: String((e && e.message) || e) });
  }
});

const PRINTER_ACTIONS = {
  pause: '/printer/print/pause',
  resume: '/printer/print/resume',
  cancel: '/printer/print/cancel',
  emergency_stop: '/printer/emergency_stop'
};

app.post('/api/printers/:id/command', checkApiKey, async (req, res) => {
  const p = loadPrinterWithIp(req, res);
  if (!p) return;
  const action = req.body && req.body.action;
  const apiPath = PRINTER_ACTIONS[action];
  if (!apiPath) return res.status(400).json({ error: 'Azione non valida' });
  try {
    await moonrakerCall(p.ip, apiPath, 'POST');
    res.json({ ok: true, action });
  } catch (e) {
    res.status(502).json({ error: 'Stampante non raggiungibile: ' + String((e && e.message) || e) });
  }
});

app.post('/api/printers/:id/gcode', checkApiKey, async (req, res) => {
  const p = loadPrinterWithIp(req, res);
  if (!p) return;
  const script = req.body && req.body.script;
  if (!script || typeof script !== 'string' || script.length > 300) return res.status(400).json({ error: 'Script non valido' });
  try {
    await moonrakerCall(p.ip, '/printer/gcode/script?script=' + encodeURIComponent(script), 'POST', 60000);
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

app.get('/api/printers/:id/files', checkApiKey, async (req, res) => {
  const p = loadPrinterWithIp(req, res);
  if (!p) return;
  try {
    const q = await moonrakerCall(p.ip, '/server/files/list?root=gcodes');
    const files = (q.result || []).map(function (f) { return { path: f.path, size: f.size, modified: f.modified }; })
      .sort(function (a, b) { return b.modified - a.modified; }).slice(0, 50);
    res.json(files);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/printers/:id/print', checkApiKey, async (req, res) => {
  const p = loadPrinterWithIp(req, res);
  if (!p) return;
  const filename = req.body && req.body.filename;
  if (!filename || typeof filename !== 'string') return res.status(400).json({ error: 'Filename mancante' });
  try {
    await moonrakerCall(p.ip, '/printer/print/start?filename=' + encodeURIComponent(filename), 'POST');
    res.json({ ok: true });
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});
// --- fine Fase 3b ---

// --- Storico stato stampanti: poll periodico + endpoint storico ---
const PRINTER_POLL_INTERVAL_MS = 5 * 60 * 1000;

async function pollAllPrintersStatus() {
  let rows;
  try { rows = db.prepare('SELECT * FROM printers WHERE ip IS NOT NULL AND ip != ?').all(''); }
  catch (e) { return; }
  for (const p of rows) {
    let online = false, message = null;
    try {
      const q = await moonrakerCall(p.ip, '/printer/objects/query?print_stats');
      online = !!(q && q.result);
    } catch (e) {
      online = false;
      message = String((e && e.message) || e);
    }
    const last = db.prepare('SELECT online FROM printer_status_log WHERE printer_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1').get(p.id);
    if (!last || Number(last.online) !== (online ? 1 : 0)) {
      db.prepare('INSERT INTO printer_status_log (user_id, printer_id, online, message) VALUES (?, ?, ?, ?)')
        .run(p.user_id, p.id, online ? 1 : 0, message);
    }
  }
}
setInterval(function(){ pollAllPrintersStatus().catch(function(){}); }, PRINTER_POLL_INTERVAL_MS);
pollAllPrintersStatus().catch(function(){});

app.get('/api/printers/:id/history', checkApiKey, async (req, res) => {
  const p = db.prepare('SELECT * FROM printers WHERE id = ? AND user_id = ?').get(req.params.id, req.userId);
  if (!p) { res.status(404).json({ error: 'Stampante non trovata' }); return; }
  const rows = db.prepare('SELECT online, message, checked_at FROM printer_status_log WHERE printer_id = ? ORDER BY checked_at DESC, id DESC LIMIT 50').all(p.id);
  const offlineSince = (rows.length && Number(rows[0].online) === 0) ? rows[0].checked_at : null;
  res.json({ events: rows, offlineSince: offlineSince });
});


// --- Correzione automatica filament_used da metadata G-code (fix bug stima grammi, sessione 11) ---
const FILAMENT_FIX_INTERVAL_MS = 60 * 1000;
async function fixFilamentUsedValues() {
  try {
    const rows = db.prepare(
      "SELECT id, printer, filename, filament_used FROM print_events WHERE filename IS NOT NULL AND filament_used IS NOT NULL AND filament_used > 3000"
    ).all();
    for (const row of rows) {
      try {
        let printerRow = db.prepare("SELECT * FROM printers WHERE notifier_name = ?").get(row.printer);
        if (!printerRow) {
          printerRow = db.prepare("SELECT * FROM printers WHERE name LIKE ?").get(row.printer + "%");
        }
        let printerIp = printerRow && printerRow.ip;
        if (!printerIp) { console.log("[filament-fix] IP non trovato per stampante: " + row.printer); continue; }
        const meta = await moonrakerCall(printerIp, "/server/files/metadata?filename=" + encodeURIComponent(row.filename));
        const weights = meta && meta.result && meta.result.filament_weights;
        if (Array.isArray(weights)) {
          const totalGrams = weights.reduce((a, b) => a + (Number(b) || 0), 0);
          if (totalGrams > 0 && Math.abs(totalGrams - row.filament_used) > 1) {
            db.prepare("UPDATE print_events SET filament_used = ? WHERE id = ?").run(totalGrams, row.id);
            console.log("[filament-fix] evento " + row.id + ": " + row.filament_used + " -> " + totalGrams + " g");
          }
        }
      } catch (innerErr) {
        console.error("[filament-fix] errore evento " + row.id + ":", innerErr.message);
      }
    }
  } catch (err) {
    console.error("[filament-fix] errore generale:", err.message);
  }
}
setInterval(fixFilamentUsedValues, FILAMENT_FIX_INTERVAL_MS);
fixFilamentUsedValues();
// --- fine correzione automatica filament_used ---

app.listen(PORT, HOST, () => {
  console.log(`SpoolBase backend in ascolto su http://${HOST}:${PORT}`);
  console.log(`Database: ${DB_PATH}`);
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  console.log(`Autenticazione multi-utente attiva: ${userCount} utenti registrati`);
  if (SINGLE_USER) {
    console.log('Modalita SINGLE_USER attiva: nessuna API key richiesta.');
    if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
      console.warn('!!! ATTENZIONE: SINGLE_USER=1 con HOST=' + HOST + ': CHIUNQUE in rete puo leggere e scrivere i tuoi dati senza autenticazione !!!');
    }
  }
});

// --- Validazione IP stampante: limita a LAN privata, esclude host di infrastruttura (hardening SSRF) ---
// PRINTER_IP_BLOCKLIST: lista opzionale di IP della propria LAN da escludere
// (es. router, server, NAS) - CSV via env var, es. "192.168.0.1,192.168.0.10"
const PRINTER_IP_BLOCKLIST = new Set(
  (process.env.PRINTER_IP_BLOCKLIST || '').split(',').map(s => s.trim()).filter(Boolean)
);
function isPrivateLanIp(o) {
  if (o[0] === 10) return true;
  if (o[0] === 192 && o[1] === 168) return true;
  if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return true;
  return false;
}
function isAllowedPrinterIp(ip) {
  if (ip === null || ip === undefined || ip === '') return true;
  if (typeof ip !== 'string') return false;
  const trimmed = ip.trim();
  const m = trimmed.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const o = m.slice(1).map(Number);
  if (o.some(x => x < 0 || x > 255)) return false;
  if (!isPrivateLanIp(o)) return false;
  if (PRINTER_IP_BLOCKLIST.has(trimmed)) return false;
  return true;
}
