export class ApiError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s } }
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try { r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }) }
  catch { throw new ApiError(0, 'No connection. Your work is still saved on this device.') }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, j.error || 'Something went wrong.')
  return j as T
}
export type Org = { id: string; name: string; role: 'owner' | 'editor' | 'viewer' }
export type Member = { id: string; email: string; role: Org['role'] }
export type BoardRow = { id: string; title: string; updated: number; rev: number; share: string | null }
export const api = {
  me: () => call<{ user: { email: string } | null; orgs: Org[] }>('GET', '/me'),
  signup: (email: string, password: string, orgName?: string) => call<{ user: { email: string } }>('POST', '/signup', { email, password, orgName }),
  login: (email: string, password: string) => call<{ user: { email: string } }>('POST', '/login', { email, password }),
  logout: () => call<{ ok: true }>('POST', '/logout'),
  list: (org: string) => call<{ boards: BoardRow[] }>('GET', '/boards?org=' + org),
  create: (board: unknown, org: string) => call<{ id: string; rev: number }>('POST', '/boards?org=' + org, { board }),
  get: (id: string) => call<{ id: string; rev: number; role: Org['role']; org: string; board: unknown }>('GET', '/boards/' + id),
  save: (id: string, board: unknown, rev: number) => call<{ rev: number }>('PUT', '/boards/' + id, { board, rev }),
  remove: (id: string) => call<{ ok: true }>('DELETE', '/boards/' + id),
  share: (id: string) => call<{ token: string }>('POST', `/boards/${id}/share`),
  unshare: (id: string) => call<{ ok: true }>('DELETE', `/boards/${id}/share`),
  createOrg: (name: string) => call<{ id: string; orgs: Org[] }>('POST', '/orgs', { name }),
  renameOrg: (id: string, name: string) => call<{ orgs: Org[] }>('PUT', '/orgs/' + id, { name }),
  members: (id: string) => call<{ members: Member[]; you: string; links: { token: string; role: string; expires: number }[] }>('GET', `/orgs/${id}/members`),
  setRole: (id: string, uid: string, role: string) => call<{ ok: true }>('PUT', `/orgs/${id}/members/${uid}`, { role }),
  removeMember: (id: string, uid: string) => call<{ ok: true }>('DELETE', `/orgs/${id}/members/${uid}`),
  joinLink: (id: string, role: string) => call<{ token: string; role: string }>('POST', `/orgs/${id}/join-link`, { role }),
  joinLinkOff: (id: string) => call<{ ok: true }>('DELETE', `/orgs/${id}/join-link`),
  joinPreview: (t: string) => call<{ org: string; role: string }>('GET', '/join/' + t),
  join: (t: string) => call<{ orgs: Org[]; joined: string }>('POST', '/join/' + t),
  shared: (token: string) => call<{ board: unknown }>('GET', '/shared/' + token),
}
