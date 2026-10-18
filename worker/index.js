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
    const { email, password, orgName } = await readJson(req, 2000)
    const e = String(email || '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e) || e.length > 200) throw new HttpErr(400, 'Enter a valid email address.')
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpErr(400, 'Use a password of at least 8 characters.')
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const id = rid(12), now = Date.now()
    try {
      await env.DB.prepare('INSERT INTO users(id, email, salt, hash, created) VALUES(?,?,?,?,?)').bind(id, e, b64(salt), await hashPw(password, salt), now).run()
    } catch { throw new HttpErr(409, 'That email already has an account. Log in instead.') }
    await makeOrg(env, id, cleanName(orgName) || (e.split('@')[0].slice(0, 40) + "'s workspace"))
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
  let m
  if ((m = /^\/shared\/([A-Za-z0-9]+)$/.exec(p)) && method === 'GET') {
    if (await limited(env, 'sh:' + ip, 120, 600000)) throw new HttpErr(429, 'Slow down.')
    const r = await env.DB.prepare('SELECT b.title, b.data FROM shares s JOIN boards b ON b.id = s.board_id WHERE s.token = ?').bind(m[1]).first()
    if (!r) throw new HttpErr(404, 'This link is switched off or does not exist.')
    return json({ board: JSON.parse(r.data), readOnly: true })
  }
  if ((m = /^\/join\/([A-Za-z0-9]+)$/.exec(p)) && method === 'GET') {
    if (await limited(env, 'jp:' + ip, 60, 600000)) throw new HttpErr(429, 'Slow down.')
    const r = await env.DB.prepare('SELECT o.name, i.role FROM invites i JOIN orgs o ON o.id = i.org_id WHERE i.token = ? AND i.expires > ?').bind(m[1], Date.now()).first()
    if (!r) throw new HttpErr(404, 'This join link is switched off or has expired.')
    return json({ org: r.name, role: r.role })
  }

  const u = await authed(req, env)
  if (p === '/me' && !u) return json({ user: null, orgs: [] })
  if (!u) throw new HttpErr(401, 'Log in to use saved boards.')

  if (p === '/me') return json({ user: { email: u.email }, orgs: await orgsOf(env, u) })

  if ((m = /^\/join\/([A-Za-z0-9]+)$/.exec(p)) && method === 'POST') {
    const r = await env.DB.prepare('SELECT org_id, role FROM invites WHERE token = ? AND expires > ?').bind(m[1], Date.now()).first()
    if (!r) throw new HttpErr(404, 'This join link is switched off or has expired.')
    await env.DB.prepare('INSERT OR IGNORE INTO members(org_id, user_id, role, created) VALUES(?,?,?,?)').bind(r.org_id, u.id, r.role, Date.now()).run()
    return json({ orgs: await orgsOf(env, u), joined: r.org_id })
  }
  if (p === '/orgs' && method === 'POST') {
    const c = await env.DB.prepare('SELECT count(*) n FROM members WHERE user_id = ? AND role = ?').bind(u.id, 'owner').first()
    if (c.n >= 10) throw new HttpErr(400, 'Organisation limit reached (10).')
    const { name } = await readJson(req, 2000)
    const id = await makeOrg(env, u.id, cleanName(name) || 'My workspace')
    return json({ id, orgs: await orgsOf(env, u) })
  }

  let om
  if ((om = /^\/orgs\/([A-Za-z0-9]+)(\/.*)?$/.exec(p))) {
    const orgId = om[1], sub = om[2] || ''
    const role = await roleIn(env, orgId, u.id)
    if (!role) throw new HttpErr(404, 'Organisation not found.')
    if (sub === '' && method === 'PUT') {
      if (role !== 'owner') throw new HttpErr(403, 'Only an owner can do that.')
      const { name } = await readJson(req, 2000)
      const n = cleanName(name); if (!n) throw new HttpErr(400, 'Enter a name.')
      await env.DB.prepare('UPDATE orgs SET name = ? WHERE id = ?').bind(n, orgId).run()
      return json({ orgs: await orgsOf(env, u) })
    }
    if (sub === '/members' && method === 'GET') {
      const r = await env.DB.prepare('SELECT m.user_id id, u.email, m.role FROM members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY m.created').bind(orgId).all()
      const inv = role === 'owner' ? await env.DB.prepare('SELECT token, role, expires FROM invites WHERE org_id = ?').bind(orgId).all() : { results: [] }
      return json({ members: r.results, you: u.id, links: inv.results })
    }
    let mm
    if ((mm = /^\/members\/([A-Za-z0-9]+)$/.exec(sub))) {
      const target = mm[1]
      if (method === 'PUT') {
        if (role !== 'owner') throw new HttpErr(403, 'Only an owner can change roles.')
        const { role: nr } = await readJson(req, 500)
        if (!ROLES.includes(nr)) throw new HttpErr(400, 'Unknown role.')
        const cur = await roleIn(env, orgId, target)
        if (!cur) throw new HttpErr(404, 'Member not found.')
        if (cur === 'owner' && nr !== 'owner' && (await ownerCount(env, orgId)) < 2) throw new HttpErr(400, 'An organisation needs at least one owner.')
        await env.DB.prepare('UPDATE members SET role = ? WHERE org_id = ? AND user_id = ?').bind(nr, orgId, target).run()
        return json({ ok: true })
      }
      if (method === 'DELETE') {
        if (role !== 'owner' && target !== u.id) throw new HttpErr(403, 'Only an owner can remove other members.')
        const cur = await roleIn(env, orgId, target)
        if (!cur) throw new HttpErr(404, 'Member not found.')
        if (cur === 'owner' && (await ownerCount(env, orgId)) < 2) throw new HttpErr(400, 'An organisation needs at least one owner.')
        await env.DB.prepare('DELETE FROM members WHERE org_id = ? AND user_id = ?').bind(orgId, target).run()
        return json({ ok: true })
      }
    }
    if (sub === '/join-link') {
      if (role !== 'owner') throw new HttpErr(403, 'Only an owner can manage join links.')
      if (method === 'POST') {
        const { role: nr } = await readJson(req, 500)
        const lr = ['editor', 'viewer'].includes(nr) ? nr : 'viewer'
        await env.DB.prepare('DELETE FROM invites WHERE org_id = ?').bind(orgId).run()
        const t = rid(18)
        await env.DB.prepare('INSERT INTO invites(token, org_id, role, created, expires) VALUES(?,?,?,?,?)').bind(t, orgId, lr, Date.now(), Date.now() + 14 * 864e5).run()
        return json({ token: t, role: lr })
      }
      if (method === 'DELETE') { await env.DB.prepare('DELETE FROM invites WHERE org_id = ?').bind(orgId).run(); return json({ ok: true }) }
    }
    throw new HttpErr(404, 'Not found.')
  }

  // boards: always scoped to an organisation the caller belongs to
  const orgs = await orgsOf(env, u)
  const wantOrg = url.searchParams.get('org')
  const org = wantOrg ? orgs.find((o) => o.id === wantOrg) : orgs[0]
  if (wantOrg && !org) throw new HttpErr(404, 'Organisation not found.')
  const canWrite = org && org.role !== 'viewer'

  if (p === '/boards' && method === 'GET') {
    const r = await env.DB.prepare('SELECT b.id, b.title, b.updated, b.rev, (SELECT token FROM shares WHERE board_id = b.id) AS share FROM boards b WHERE b.org_id = ? ORDER BY updated DESC LIMIT 200').bind(org.id).all()
    return json({ boards: r.results, org: org.id, role: org.role })
  }
  if (p === '/boards' && method === 'POST') {
    if (!canWrite) throw new HttpErr(403, 'You have view-only access in this organisation.')
    const c = await env.DB.prepare('SELECT count(*) n FROM boards WHERE org_id = ?').bind(org.id).first()
    if (c.n >= 500) throw new HttpErr(400, 'Board limit reached (500).')
    const { board } = await readJson(req); checkBoard(board)
    const id = rid(12), now = Date.now()
    await env.DB.prepare('INSERT INTO boards(id, owner_id, org_id, title, data, rev, updated) VALUES(?,?,?,?,?,1,?)').bind(id, u.id, org.id, String(board.title || 'Untitled').slice(0, 120), JSON.stringify(board), now).run()
    return json({ id, rev: 1, updated: now, org: org.id })
  }
  const bm = /^\/boards\/([A-Za-z0-9]+)(\/share)?$/.exec(p)
  if (bm) {
    const row = await env.DB.prepare('SELECT id, org_id, title, data, rev, updated FROM boards WHERE id = ?').bind(bm[1]).first()
    const brole = row ? await roleIn(env, row.org_id, u.id) : null
    if (!row || !brole) throw new HttpErr(404, 'Board not found.')
    const w = brole !== 'viewer'
    if (!bm[2]) {
      if (method === 'GET') return json({ id: row.id, rev: row.rev, updated: row.updated, org: row.org_id, role: brole, board: JSON.parse(row.data) })
      if (!w) throw new HttpErr(403, 'You have view-only access in this organisation.')
      if (method === 'PUT') {
        const { board, rev } = await readJson(req); checkBoard(board)
        if (rev !== row.rev) throw new HttpErr(409, 'This board changed somewhere else. Reload it before saving.')
        const now = Date.now()
        await env.DB.prepare('UPDATE boards SET title = ?, data = ?, rev = rev + 1, updated = ? WHERE id = ? AND rev = ?').bind(String(board.title || 'Untitled').slice(0, 120), JSON.stringify(board), now, row.id, row.rev).run()
        return json({ id: row.id, rev: row.rev + 1, updated: now })
      }
      if (method === 'DELETE') {
        await env.DB.prepare('DELETE FROM shares WHERE board_id = ?').bind(row.id).run()
        await env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(row.id).run()
        return json({ ok: true })
      }
    } else {
      if (!w) throw new HttpErr(403, 'You have view-only access in this organisation.')
      if (method === 'POST') {
        const ex = await env.DB.prepare('SELECT token FROM shares WHERE board_id = ?').bind(row.id).first()
        if (ex) return json({ token: ex.token })
        const t = rid(18)
        await env.DB.prepare('INSERT INTO shares(token, board_id, created) VALUES(?,?,?)').bind(t, row.id, Date.now()).run()
        return json({ token: t })
      }
      if (method === 'DELETE') { await env.DB.prepare('DELETE FROM shares WHERE board_id = ?').bind(row.id).run(); return json({ ok: true }) }
    }
  }
  throw new HttpErr(404, 'Not found.')
}

const ROLES = ['owner', 'editor', 'viewer']
const cleanName = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 80)
async function roleIn(env, orgId, userId) {
  const r = await env.DB.prepare('SELECT role FROM members WHERE org_id = ? AND user_id = ?').bind(orgId, userId).first()
  return r ? r.role : null
}
async function ownerCount(env, orgId) {
  return (await env.DB.prepare("SELECT count(*) n FROM members WHERE org_id = ? AND role = 'owner'").bind(orgId).first()).n
}
async function makeOrg(env, userId, name) {
  const id = rid(12), now = Date.now()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO orgs(id, name, created) VALUES(?,?,?)').bind(id, name, now),
    env.DB.prepare("INSERT INTO members(org_id, user_id, role, created) VALUES(?,?,'owner',?)").bind(id, userId, now),
  ])
  return id
}
// Every account always has at least one organisation. Boards saved before organisations existed move into the owner's first one.
async function orgsOf(env, u) {
  let r = await env.DB.prepare('SELECT o.id, o.name, m.role FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY m.created').bind(u.id).all()
  if (!r.results.length) {
    await makeOrg(env, u.id, (u.email.split('@')[0].slice(0, 40) || 'My') + "'s workspace")
    r = await env.DB.prepare('SELECT o.id, o.name, m.role FROM members m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = ? ORDER BY m.created').bind(u.id).all()
  }
  await env.DB.prepare('UPDATE boards SET org_id = ? WHERE owner_id = ? AND org_id IS NULL').bind(r.results[0].id, u.id).run()
  return r.results
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
