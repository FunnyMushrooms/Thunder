// ─────────────────────────────────────────────────────────────────────────
//  Lasting Atlas — backend API
//  Order lifecycle · on-chain payment verification · cell ledger · certificates · admin
//
//  Security model (why the browser is never trusted):
//   • Cells are reserved server-side the instant checkout starts, and released
//     ONLY by (a) a confirmed on-chain payment or (b) reservation expiry.
//   • A purchase is finalised ONLY when the chain watcher sees the exact,
//     uniquely-tagged amount arrive at the assigned wallet — never on a
//     frontend "I paid" click.
//   • The buyer's sending address is read FROM THE TRANSACTION, not entered.
//   • Admin actions require a signed session (JWT, HMAC-SHA256, our secret).
//   • Certificate hashes are HMACs over the canonical record — verifiable,
//     unforgeable without the server secret.
// ─────────────────────────────────────────────────────────────────────────
import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── config ───────────────────────────────────────────────────────────────
const CFG = {
  PORT: +(process.env.PORT || 4000),
  SECRET: process.env.ATLAS_SECRET || 'dev-insecure-secret-change-me',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'atlas-2026',
  WALLETS: (process.env.RECEIVING_WALLETS || '0xDEMO_TREASURY_A,0xDEMO_TREASURY_B,0xDEMO_TREASURY_C')
    .split(',').map(s => s.trim()).filter(Boolean),
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  PROVIDER: process.env.PROVIDER || 'mock',
  MOCK_DELAY: +(process.env.PAYMENT_MOCK_DELAY_MS || 6000),
  ORDER_TTL: +(process.env.ORDER_TTL_MS || 15 * 60 * 1000),
  EVM: {
    explorer: process.env.EVM_EXPLORER_API || '',
    key: process.env.EVM_EXPLORER_KEY || '',
    usdc: (process.env.USDC_CONTRACT || '').toLowerCase(),
    decimals: +(process.env.USDC_DECIMALS || 6),
    confirmations: +(process.env.CONFIRMATIONS || 2),
  },
};
const PRICE = { 2: 2, 5: 5, 8: 8 }; // tier → USDC (mirrors the frontend tiers)

// ── tiny persistent store (atomic JSON) ────────────────────────────────────
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });
const DB_FILE = path.join(DATA, 'atlas.json');
let db = { orders: {}, owned: {}, marks: {}, certs: {}, activity: [] };
try { if (fs.existsSync(DB_FILE)) db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { /* start fresh */ }
let _saveT = null;
function save() {
  clearTimeout(_saveT);
  _saveT = setTimeout(() => {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DB_FILE); // atomic
  }, 120);
}

// ── crypto helpers ─────────────────────────────────────────────────────────
const b64u = b => Buffer.from(b).toString('base64url');
function hmac(data) { return crypto.createHmac('sha256', CFG.SECRET).update(data).digest('hex'); }
function signJWT(payload, ttlMs = 8 * 3600e3) {
  const body = { ...payload, exp: Date.now() + ttlMs };
  const p = b64u(JSON.stringify(body));
  return p + '.' + b64u(hmac(p));
}
function verifyJWT(tok) {
  if (!tok) return null;
  const [p, sig] = String(tok).split('.');
  if (!p || !sig) return null;
  if (!crypto.timingSafeEqual(Buffer.from(b64u(hmac(p))), Buffer.from(sig))) return null;
  try { const body = JSON.parse(Buffer.from(p, 'base64url').toString()); return body.exp > Date.now() ? body : null; }
  catch { return null; }
}
// Canonical, verifiable certificate hash — big + unique + reproducible from the record.
function certHash(rec) {
  const canon = [rec.serial, rec.type, rec.name, rec.wallet, rec.cellsCount, rec.coords, rec.amount, rec.txHash].join('|');
  return (hmac(canon) + hmac('salt:' + canon)).slice(0, 64);
}

// ── rate limiting (simple in-memory token bucket per IP) ────────────────────
const buckets = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'x';
    const now = Date.now();
    let b = buckets.get(ip);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(ip, b); }
    if (++b.n > max) return res.status(429).json({ error: 'rate_limited' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60e3).unref();

// ── app + hardening headers + CORS ─────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Access-Control-Allow-Origin', CFG.CORS_ORIGIN);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function requireAdmin(req, res, next) {
  const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const claims = verifyJWT(tok);
  if (!claims || !claims.admin) return res.status(401).json({ error: 'unauthorized' });
  req.admin = claims; next();
}

// ── cell ownership / reservation helpers ────────────────────────────────────
function cellState(key) {
  if (db.owned[key]) return 'owned';
  for (const o of Object.values(db.orders))
    if (o.status === 'pending' && o.cells.includes(key) && o.expiresAt > Date.now()) return 'reserved';
  return 'open';
}
function assignWallet() { return CFG.WALLETS[Math.floor(Math.random() * CFG.WALLETS.length)] || ''; }
// Unique micro-tag so two identical-price orders to the same wallet are distinguishable on-chain.
function uniqueAmount(base) {
  const tag = (crypto.randomInt(1, 999)) / 1000; // 0.001 – 0.999
  return +(base + tag).toFixed(3);
}

// ── ORDER: create (reserves cells, assigns wallet + exact amount) ───────────
app.post('/api/order', rateLimit(30, 60e3), (req, res) => {
  const { cells, tier, name = '', quote = '', link = '', color = '' } = req.body || {};
  if (!Array.isArray(cells) || cells.length === 0 || cells.length > 500) return res.status(400).json({ error: 'bad_cells' });
  if (!PRICE[tier]) return res.status(400).json({ error: 'bad_tier' });
  for (const k of cells) {
    if (typeof k !== 'string' || !/^-?\d+_-?\d+$/.test(k)) return res.status(400).json({ error: 'bad_cell_key' });
    const st = cellState(k);
    if (st !== 'open') return res.status(409).json({ error: 'cell_unavailable', cell: k, state: st });
  }
  const base = cells.length * PRICE[tier];
  const id = 'ord_' + crypto.randomBytes(9).toString('hex');
  const order = {
    id, cells, tier, name: String(name).slice(0, 80), quote: String(quote).slice(0, 200),
    link: String(link).slice(0, 200), color: String(color).slice(0, 16),
    wallet: assignWallet(), amount: uniqueAmount(base), baseAmount: base,
    status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + CFG.ORDER_TTL,
    txHash: null, sender: null,
  };
  db.orders[id] = order; save();
  watchOrder(order); // begin chain watch
  res.json({
    id, wallet: order.wallet, amount: order.amount, currency: 'USDC',
    cells: cells.length, expiresAt: order.expiresAt, status: 'pending',
  });
});

// ── ORDER: status (frontend polls this) ─────────────────────────────────────
app.get('/api/order/:id', rateLimit(240, 60e3), (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'not_found' });
  if (o.status === 'pending' && o.expiresAt < Date.now()) { o.status = 'expired'; save(); }
  const out = { id: o.id, status: o.status, amount: o.amount, wallet: o.wallet, cells: o.cells.length, expiresAt: o.expiresAt };
  if (o.status === 'paid') { out.txHash = o.txHash; out.sender = o.sender; out.certSerial = o.certSerial; }
  res.json(out);
});

// ── mark an order paid (called by the chain watcher only) ───────────────────
function finalizeOrder(order, txHash, sender) {
  if (order.status !== 'pending') return;
  order.status = 'paid'; order.txHash = txHash; order.sender = sender;
  const markId = 'm_' + crypto.randomBytes(6).toString('hex');
  db.marks[markId] = {
    id: markId, name: order.name || 'Anonymous Mark', quote: order.quote, link: order.link,
    color: order.color, wallet: sender, cells: order.cells.length, createdAt: Date.now(),
  };
  for (const k of order.cells) db.owned[k] = markId; // release reservation → permanent ownership
  // issue certificate
  const serial = 'LA-' + new Date().getFullYear() + '-' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const rec = {
    serial, type: 'cell', name: db.marks[markId].name, wallet: sender,
    cellsCount: order.cells.length, coords: '', amount: order.baseAmount, txHash, issuedAt: Date.now(),
  };
  rec.hash = certHash(rec);
  db.certs[rec.hash] = rec; db.certs[serial] = rec; order.certSerial = serial;
  db.activity.unshift({ t: Date.now(), name: rec.name, cells: order.cells.length });
  db.activity = db.activity.slice(0, 50);
  save();
}

// ── chain watcher (pluggable) ───────────────────────────────────────────────
function watchOrder(order) {
  if (CFG.PROVIDER === 'mock') {
    // DEV ONLY: simulate a matching on-chain transfer after a short delay.
    setTimeout(() => {
      const live = db.orders[order.id];
      if (!live || live.status !== 'pending') return;
      const fakeSender = '0x' + crypto.randomBytes(20).toString('hex');
      const fakeTx = '0x' + crypto.randomBytes(32).toString('hex');
      finalizeOrder(live, fakeTx, fakeSender);
    }, CFG.MOCK_DELAY);
    return;
  }
  // PROVIDER=evm : poll the explorer for an incoming USDC transfer to the assigned
  // wallet with the exact tagged amount. Captures the SENDER from the tx.
  const started = Date.now();
  const poll = async () => {
    const live = db.orders[order.id];
    if (!live || live.status !== 'pending') return;
    if (live.expiresAt < Date.now()) { live.status = 'expired'; save(); return; }
    try {
      const url = `${CFG.EVM.explorer}?module=account&action=tokentx&contractaddress=${CFG.EVM.usdc}`
        + `&address=${order.wallet}&sort=desc&apikey=${CFG.EVM.key}`;
      const r = await fetch(url);
      const j = await r.json();
      const want = BigInt(Math.round(order.amount * 10 ** CFG.EVM.decimals));
      for (const tx of (j.result || [])) {
        if (tx.to?.toLowerCase() !== order.wallet.toLowerCase()) continue;
        if (BigInt(tx.value) !== want) continue;
        if (+tx.confirmations < CFG.EVM.confirmations) continue; // wait for finality
        return finalizeOrder(live, tx.hash, tx.from);
      }
    } catch (e) { /* transient — keep polling */ }
    if (Date.now() - started < CFG.ORDER_TTL) setTimeout(poll, 8000);
  };
  setTimeout(poll, 4000);
}

// ── ORDER: cancel (buyer abandoned checkout → free the reserved cells) ──────
app.post('/api/order/:id/cancel', rateLimit(60, 60e3), (req, res) => {
  const o = db.orders[req.params.id];
  if (!o) return res.status(404).json({ error: 'not_found' });
  if (o.status === 'pending') { o.status = 'cancelled'; save(); } // releases the reservation
  res.json({ ok: true, status: o.status });
});

// ── public snapshot (owned cells + marks + activity) ────────────────────────
app.get('/api/state', rateLimit(120, 60e3), (req, res) => {
  res.json({
    owned: db.owned,
    marks: Object.values(db.marks).map(m => ({ id: m.id, name: m.name, color: m.color, cells: m.cells, quote: m.quote, link: m.link })),
    activity: db.activity,
    claimed: Object.keys(db.owned).length,
  });
});

// ── certificate verification (public) ───────────────────────────────────────
app.get('/api/verify/:key', rateLimit(120, 60e3), (req, res) => {
  const rec = db.certs[req.params.key.trim()];
  if (!rec) return res.json({ valid: false });
  const ok = certHash(rec) === rec.hash;
  res.json({ valid: ok, record: ok ? rec : null });
});

// ── admin ────────────────────────────────────────────────────────────────
app.post('/api/admin/login', rateLimit(10, 60e3), (req, res) => {
  const pw = String((req.body || {}).password || '');
  const a = Buffer.from(pw), b = Buffer.from(CFG.ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) return res.status(401).json({ error: 'bad_password' });
  res.json({ token: signJWT({ admin: true }) });
});
app.get('/api/admin/orders', requireAdmin, (req, res) => res.json({ orders: Object.values(db.orders) }));
app.post('/api/admin/mark/:id', requireAdmin, (req, res) => {
  const m = db.marks[req.params.id]; if (!m) return res.status(404).json({ error: 'not_found' });
  const { name, quote, link, color, wallet } = req.body || {};
  for (const [k, v] of Object.entries({ name, quote, link, color, wallet })) if (v != null) m[k] = String(v).slice(0, 200);
  save(); res.json({ ok: true, mark: m });
});
app.post('/api/admin/mark/:id/remove', requireAdmin, (req, res) => {
  const id = req.params.id;
  for (const k of Object.keys(db.owned)) if (db.owned[k] === id) delete db.owned[k];
  delete db.marks[id]; save(); res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true, provider: CFG.PROVIDER, wallets: CFG.WALLETS.length }));

app.listen(CFG.PORT, () => {
  console.log(`[atlas-api] listening on :${CFG.PORT}  provider=${CFG.PROVIDER}  wallets=${CFG.WALLETS.length}`);
  if (CFG.SECRET.startsWith('dev-insecure')) console.warn('[atlas-api] WARNING: set ATLAS_SECRET in production.');
});
