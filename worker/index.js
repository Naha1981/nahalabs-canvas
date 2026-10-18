// NahaLabs Canvas API: accounts, saved boards, view-only sharing.
const enc = new TextEncoder()
const json = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } })
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
const rid = (n = 24) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[+/=]/g, '').slice(0, n * 4 / 3 | 0)
const ITER = 60000

async function hashPw(pw, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits'])
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, key, 256))
}
async function sha(s) { return b64(await crypto.subtle.digest('SHA-256', enc.encode(s))) }
const tse = (a, b) => a.length === b.length && [...a].reduce((x, c, i) => x | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0

function cookie(token, maxAge) {
  return `nl_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`
}
async function authed(req, env) {
  const m = /(?:^|;\s*)nl_session=([^;]+)/.exec(req.headers.get('cookie') || '')
  if (!m) return null
  const row = await env.DB.prepare('SELECT u.id, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires > ?').bind(await sha(m[1]), Date.now()).first()
  return row || null
}
async function readJson(req, max = 400000) {
  const t = await req.text()
  if (t.length > max) throw new HttpErr(413, 'Too large.')
  try { return JSON.parse(t) } catch { throw new HttpErr(400, 'Bad request.') }
}
class HttpErr extends Error { constructor(s, m) { super(m); this.s = s } }

function checkBoard(b) {
  if (!b || typeof b !== 'object' || !Array.isArray(b.nodes) || !Array.isArray(b.edges)) throw new HttpErr(400, 'Not a board.')
  if (b.nodes.length > 300 || b.edges.length > 600) throw new HttpErr(400, 'Board is too large.')
}
async function limited(env, key, max, windowMs) {
  const now = Date.now(), start = now - (now % windowMs)
  const k = `${key}:${start}`
  await env.DB.prepare('INSERT INTO rl(k, n, t) VALUES(?, 1, ?) ON CONFLICT(k) DO UPDATE SET n = n + 1').bind(k, now).run()
  const r = await env.DB.prepare('SELECT n FROM rl WHERE k = ?').bind(k).first()
  if (now % 97 === 0) await env.DB.prepare('DELETE FROM rl WHERE t < ?').bind(now - 3600000).run()
  return r.n > max
}

async function api(req, env, url) {
  const p = url.pathname.replace(/^\/api/, '')
  const ip = req.headers.get('cf-connecting-ip') || 'x'
  const method = req.method
  if (method !== 'GET' && method !== 'HEAD') {
    const o = req.headers.get('origin')
    if (o && new URL(o).host !== url.host) throw new HttpErr(403, 'Blocked.')
  }

  if (p === '/signup' && method === 'POST') {
    if (await limited(env, 'su:' + ip, 20, 3600000)) throw new HttpErr(429, 'Too many sign-ups from this network. Try again later.')
    const { email, password } = await readJson(req, 2000)
    const e = String(email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 200) throw new HttpErr(400, 'Enter a valid email address.')
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpErr(400, 'Use a password of at least 8 characters.')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const id = rid(12), now = Date.now()
    try {
      await env.DB.prepare('INSERT INTO users(id, email, salt, hash, created) VALUES(?,?,?,?,?)').bind(id, e, b64(salt), await hashPw(password, salt), now).run()
    } catch { throw new HttpErr(409, 'That email already has an account. Log in instead.') }
    return session(env, id, e)
  }
  if (p === '/login' && method === 'POST') {
    if (await limited(env, 'li:' + ip, 30, 600000)) throw new HttpErr(429, 'Too many attempts. Wait a few minutes.')
    const { email, password } = await readJson(req, 2000)
    const e = String(email || '').trim().toLowerCase()
    const u = await env.DB.prepare('SELECT id, salt, hash FROM users WHERE email = ?').bind(e).first()
    const salt = u ? unb64(u.salt) : crypto.getRandomValues(new Uint8Array(16))
    const h = await hashPw(String(password || '').slice(0, 200), salt)
    if (!u || !tse(h, u.hash)) throw new HttpErr(401, 'Email or password is not right.')
    return session(env, u.id, e)
  }
  if (p === '/logout' && method === 'POST') {
    const m = /(?:^|;\s*)nl_session=([^;]+)/.exec(req.headers.get('cookie') || '')
    if (m) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha(m[1])).run()
    return json({ ok: true }, 200, { 'set-cookie': cookie('', 0) })
  }
  if (p === '/me') {
    const u = await authed(req, env)
    return json({ user: u ? { email: u.email } : null })
  }
  let m
  if ((m = /^\/shared\/([A-Za-z0-9]+)$/.exec(p)) && method === 'GET') {
    if (await limited(env, 'sh:' + ip, 120, 600000)) throw new HttpErr(429, 'Slow down.')
    const r = await env.DB.prepare('SELECT b.title, b.data FROM shares s JOIN boards b ON b.id = s.board_id WHERE s.token = ?').bind(m[1]).first()
    if (!r) throw new HttpErr(404, 'This link is switched off or does not exist.')
    return json({ board: JSON.parse(r.data), readOnly: true })
  }

  const u = await authed(req, env)
  if (!u) throw new HttpErr(401, 'Log in to use saved boards.')

  if (p === '/boards' && method === 'GET') {
    const r = await env.DB.prepare('SELECT b.id, b.title, b.updated, b.rev, (SELECT token FROM shares WHERE board_id = b.id) AS share FROM boards b WHERE owner_id = ? ORDER BY updated DESC LIMIT 200').bind(u.id).all()
    return json({ boards: r.results })
  }
  if (p === '/boards' && method === 'POST') {
    const c = await env.DB.prepare('SELECT count(*) n FROM boards WHERE owner_id = ?').bind(u.id).first()
    if (c.n >= 200) throw new HttpErr(400, 'Board limit reached (200).')
    const { board } = await readJson(req); checkBoard(board)
    const id = rid(12), now = Date.now()
    await env.DB.prepare('INSERT INTO boards(id, owner_id, title, data, rev, updated) VALUES(?,?,?,?,1,?)').bind(id, u.id, String(board.title || 'Untitled').slice(0, 120), JSON.stringify(board), now).run()
    return json({ id, rev: 1, updated: now })
  }
  if ((m = /^\/boards\/([A-Za-z0-9]+)$/.exec(p))) {
    const row = await env.DB.prepare('SELECT id, title, data, rev, updated FROM boards WHERE id = ? AND owner_id = ?').bind(m[1], u.id).first()
    if (!row) throw new HttpErr(404, 'Board not found.')
    if (method === 'GET') return json({ id: row.id, rev: row.rev, updated: row.updated, board: JSON.parse(row.data) })
    if (method === 'PUT') {
      const { board, rev } = await readJson(req); checkBoard(board)
      if (rev !== row.rev) throw new HttpErr(409, 'This board changed somewhere else. Reload it before saving.')
      const now = Date.now()
      await env.DB.prepare('UPDATE boards SET title = ?, data = ?, rev = rev + 1, updated = ? WHERE id = ? AND owner_id = ? AND rev = ?').bind(String(board.title || 'Untitled').slice(0, 120), JSON.stringify(board), now, row.id, u.id, row.rev).run()
      return json({ id: row.id, rev: row.rev + 1, updated: now })
    }
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM shares WHERE board_id = ?').bind(row.id).run()
      await env.DB.prepare('DELETE FROM boards WHERE id = ? AND owner_id = ?').bind(row.id, u.id).run()
      return json({ ok: true })
    }
  }
  if ((m = /^\/boards\/([A-Za-z0-9]+)\/share$/.exec(p))) {
    const row = await env.DB.prepare('SELECT id FROM boards WHERE id = ? AND owner_id = ?').bind(m[1], u.id).first()
    if (!row) throw new HttpErr(404, 'Board not found.')
    if (method === 'POST') {
      const ex = await env.DB.prepare('SELECT token FROM shares WHERE board_id = ?').bind(row.id).first()
      if (ex) return json({ token: ex.token })
      const t = rid(18)
      await env.DB.prepare('INSERT INTO shares(token, board_id, created) VALUES(?,?,?)').bind(t, row.id, Date.now()).run()
      return json({ token: t })
    }
    if (method === 'DELETE') { await env.DB.prepare('DELETE FROM shares WHERE board_id = ?').bind(row.id).run(); return json({ ok: true }) }
  }
  throw new HttpErr(404, 'Not found.')
}
async function session(env, userId, email) {
  const token = rid(32), exp = Date.now() + 30 * 864e5
  await env.DB.prepare('INSERT INTO sessions(token_hash, user_id, expires) VALUES(?,?,?)').bind(await sha(token), userId, exp).run()
  return json({ user: { email } }, 200, { 'set-cookie': cookie(token, 30 * 86400) })
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url) } catch (e) {
        if (e instanceof HttpErr) return json({ error: e.message }, e.s)
        return json({ error: 'Something went wrong. Try again.' }, 500)
      }
    }
    return env.ASSETS.fetch(req)
  },
}
