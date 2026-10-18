// Run: BASE=http://localhost:8787 node test/orgs.test.mjs
const BASE = process.env.BASE || 'http://localhost:8787'
let fails = 0
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++ }
class Client {
  constructor() { this.c = '' }
  async call(method, path, body) {
    const r = await fetch(BASE + '/api' + path, { method, headers: { 'content-type': 'application/json', cookie: this.c }, body: body ? JSON.stringify(body) : undefined })
    const sc = r.headers.get('set-cookie'); if (sc) this.c = sc.split(';')[0]
    return { s: r.status, j: await r.json().catch(() => ({})) }
  }
}
const stamp = Date.now()
const mk = async (n, orgName) => { const c = new Client(); const r = await c.call('POST', '/signup', { email: `qa+org${n}${stamp}@nahalabs.co.za`, password: 'org-test-pass-1', orgName }); ok(r.s === 200, `signup ${n}`); return c }
const board = (t) => ({ title: t, nodes: [], edges: [] })

const A = await mk('a', 'Acme Freight'), B = await mk('b'), C = await mk('c')
const meA = (await A.call('GET', '/me')).j, meB = (await B.call('GET', '/me')).j
ok(meA.orgs.length === 1 && meA.orgs[0].name === 'Acme Freight' && meA.orgs[0].role === 'owner', 'A owns an org created at signup')
ok(meB.orgs.length === 1 && /workspace/.test(meB.orgs[0].name), 'B gets a default workspace')
ok(meA.orgs[0].id !== meB.orgs[0].id, 'A and B are in different orgs')
const orgA = meA.orgs[0].id, orgB = meB.orgs[0].id

const created = (await A.call('POST', '/boards?org=' + orgA, { board: board('A board') })).j
ok(!!created.id, 'A creates a board in org A')
// cross-org isolation
let r = await B.call('GET', '/boards?org=' + orgA); ok(r.s === 404, 'B cannot list org A boards (404)')
r = await B.call('GET', '/boards/' + created.id); ok(r.s === 404, 'B cannot read A board')
r = await B.call('PUT', '/boards/' + created.id, { board: board('x'), rev: 1 }); ok(r.s === 404, 'B cannot edit A board')
r = await B.call('DELETE', '/boards/' + created.id); ok(r.s === 404, 'B cannot delete A board')
r = await B.call('POST', `/boards/${created.id}/share`); ok(r.s === 404, 'B cannot share A board')
r = await B.call('GET', `/orgs/${orgA}/members`); ok(r.s === 404, 'B cannot list org A members')
r = await B.call('POST', `/orgs/${orgA}/join-link`, { role: 'editor' }); ok(r.s === 404, 'B cannot create join link for org A')
r = await B.call('PUT', `/orgs/${orgA}/members/${meB.user ? 'x' : 'x'}`, { role: 'owner' }); ok(r.s === 404, 'B cannot self-promote in org A')
r = await B.call('POST', '/boards', { board: board('B board') }); ok(r.s === 200 && r.j.org === orgB, 'B default boards go to org B')
r = await A.call('GET', '/boards?org=' + orgA); ok(r.j.boards.length === 1 && r.j.boards[0].title === 'A board', 'A sees only own org boards')
r = await B.call('GET', '/boards'); ok(r.j.boards.length === 1 && r.j.boards[0].title === 'B board', 'B sees only own org boards')

// join links and roles
r = await A.call('POST', `/orgs/${orgA}/join-link`, { role: 'viewer' }); ok(r.s === 200 && r.j.token, 'A (owner) creates a viewer join link')
const tok = r.j.token
r = await new Client().call('GET', '/join/' + tok); ok(r.s === 200 && r.j.org === 'Acme Freight', 'link preview shows org name only')
r = await new Client().call('POST', '/join/' + tok); ok(r.s === 401, 'joining needs an account')
r = await B.call('POST', '/join/' + tok); ok(r.s === 200, 'B joins org A as viewer')
r = await B.call('GET', `/boards?org=${orgA}`); ok(r.s === 200 && r.j.role === 'viewer' && r.j.boards.length === 1, 'B (viewer) can read org A boards')
r = await B.call('POST', `/boards?org=${orgA}`, { board: board('nope') }); ok(r.s === 403, 'viewer cannot create')
r = await B.call('PUT', '/boards/' + created.id, { board: board('x'), rev: 1 }); ok(r.s === 403, 'viewer cannot edit')
r = await B.call('DELETE', '/boards/' + created.id); ok(r.s === 403, 'viewer cannot delete')
r = await B.call('POST', `/boards/${created.id}/share`); ok(r.s === 403, 'viewer cannot share')
r = await B.call('POST', `/orgs/${orgA}/join-link`, { role: 'editor' }); ok(r.s === 403, 'viewer cannot make join links')
r = await B.call('GET', `/orgs/${orgA}/members`); ok(r.s === 200 && r.j.members.length === 2 && r.j.links.length === 0, 'viewer sees members but not join links')
const bId = meB.user && (await A.call('GET', `/orgs/${orgA}/members`)).j.members.find((m) => m.email.includes('orgb')).id
r = await A.call('PUT', `/orgs/${orgA}/members/${bId}`, { role: 'editor' }); ok(r.s === 200, 'owner promotes B to editor')
r = await B.call('PUT', '/boards/' + created.id, { board: board('A board edited'), rev: 1 }); ok(r.s === 200 && r.j.rev === 2, 'editor edits board')
r = await B.call('PUT', `/orgs/${orgA}/members/${bId}`, { role: 'owner' }); ok(r.s === 403, 'editor cannot promote self')
r = await C.call('GET', '/boards/' + created.id); ok(r.s === 404, 'C (not a member) still blocked')
const aId = (await A.call('GET', `/orgs/${orgA}/members`)).j.you
r = await A.call('PUT', `/orgs/${orgA}/members/${aId}`, { role: 'viewer' }); ok(r.s === 400, 'cannot demote the last owner')
r = await A.call('DELETE', `/orgs/${orgA}/members/${aId}`); ok(r.s === 400, 'last owner cannot leave')
r = await B.call('DELETE', `/orgs/${orgA}/members/${aId}`); ok(r.s === 403, 'editor cannot remove the owner')
r = await A.call('DELETE', `/orgs/${orgA}/join-link`); ok(r.s === 200, 'owner switches off join link')
r = await C.call('POST', '/join/' + tok); ok(r.s === 404, 'switched-off link no longer works')
r = await A.call('DELETE', `/orgs/${orgA}/members/${bId}`); ok(r.s === 200, 'owner removes B')
r = await B.call('GET', '/boards/' + created.id); ok(r.s === 404, 'removed member loses access at once')
// share link is the only public path
r = await A.call('POST', `/boards/${created.id}/share`); const st = r.j.token
r = await new Client().call('GET', '/shared/' + st); ok(r.s === 200 && r.j.readOnly, 'share link gives anonymous read-only')
r = await new Client().call('GET', '/boards'); ok(r.s === 401, 'anonymous cannot list boards')
// extra org
r = await B.call('POST', '/orgs', { name: 'B second org' }); ok(r.s === 200 && r.j.orgs.length === 2, 'any user can create another org')
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
