// Cloudflare Pages Function: /api/queues  (ต้อง bind D1 ชื่อ DB)
const MAX_DAILY = 4;
const json = (o, s = 200) =>
  new Response(JSON.stringify(o), {
    status: s,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

async function ensure(db) {
  await db.prepare(
    'CREATE TABLE IF NOT EXISTS queues (id TEXT PRIMARY KEY, date TEXT NOT NULL, time TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'waiting\', data TEXT NOT NULL, updated_at INTEGER NOT NULL)'
  ).run();
}

async function listAll(db) {
  const { results } = await db.prepare('SELECT data FROM queues ORDER BY date, time').all();
  return results.map(r => JSON.parse(r.data));
}

export async function onRequestGet({ env }) {
  if (!env.DB) return json({ error: 'D1 binding "DB" not found' }, 500);
  await ensure(env.DB);
  return json({ queues: await listAll(env.DB) });
}

// body: { upserts: [queue...], deletes: [id...], replaceAll?: [queue...] }
export async function onRequestPost({ env, request }) {
  if (!env.DB) return json({ error: 'D1 binding "DB" not found' }, 500);
  const db = env.DB;
  await ensure(db);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'bad json' }, 400); }

  const conflicts = [];
  const now = Date.now();
  const stmts = [];
  const clean = q => ({
    id: String(q.id).slice(0, 80),
    queueNo: String(q.queueNo || '').slice(0, 20),
    date: String(q.date || '').slice(0, 10),
    time: String(q.time || '').slice(0, 5),
    customerName: String(q.customerName || '').slice(0, 120),
    phone: String(q.phone || '').slice(0, 40),
    serviceIds: Array.isArray(q.serviceIds) ? q.serviceIds.map(String).slice(0, 20) : [],
    price: Number(q.price) || 0,
    durationMins: Number(q.durationMins) || 45,
    drink: String(q.drink || '').slice(0, 80),
    note: String(q.note || '').slice(0, 500),
    status: String(q.status || 'waiting').slice(0, 20)
  });
  const put = q =>
    db.prepare(
      'INSERT INTO queues (id,date,time,status,data,updated_at) VALUES (?,?,?,?,?,?) ' +
      'ON CONFLICT(id) DO UPDATE SET date=excluded.date,time=excluded.time,status=excluded.status,data=excluded.data,updated_at=excluded.updated_at'
    ).bind(q.id, q.date, q.time, q.status, JSON.stringify(q), now);

  if (Array.isArray(body.replaceAll)) {
    stmts.push(db.prepare('DELETE FROM queues'));
    body.replaceAll.forEach(q => stmts.push(put(clean(q))));
  } else {
    for (const raw of body.upserts || []) {
      const q = clean(raw);
      if (!q.id || !q.date || !q.time) continue;
      if (q.status !== 'cancelled') {
        const { results } = await db
          .prepare("SELECT id, time FROM queues WHERE date=? AND status!='cancelled' AND id!=?")
          .bind(q.date, q.id).all();
        if (results.some(r => r.time === q.time)) { conflicts.push({ id: q.id, reason: 'slot' }); continue; }
        if (results.length >= MAX_DAILY) { conflicts.push({ id: q.id, reason: 'full' }); continue; }
      }
      stmts.push(put(q));
    }
    for (const id of body.deletes || []) {
      stmts.push(db.prepare('DELETE FROM queues WHERE id=?').bind(String(id)));
    }
  }
  if (stmts.length) await db.batch(stmts);
  return json({ ok: true, conflicts, queues: await listAll(db) });
}
