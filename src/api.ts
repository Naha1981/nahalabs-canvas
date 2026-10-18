export class ApiError extends Error { status: number; constructor(s: number, m: string) { super(m); this.status = s } }
async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response
  try { r = await fetch('/api' + path, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined }) }
  catch { throw new ApiError(0, 'No connection. Your work is still saved on this device.') }
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, j.error || 'Something went wrong.')
  return j as T
}
export type BoardRow = { id: string; title: string; updated: number; rev: number; share: string | null }
export const api = {
  me: () => call<{ user: { email: string } | null }>('GET', '/me'),
  signup: (email: string, password: string) => call<{ user: { email: string } }>('POST', '/signup', { email, password }),
  login: (email: string, password: string) => call<{ user: { email: string } }>('POST', '/login', { email, password }),
  logout: () => call<{ ok: true }>('POST', '/logout'),
  list: () => call<{ boards: BoardRow[] }>('GET', '/boards'),
  create: (board: unknown) => call<{ id: string; rev: number }>('POST', '/boards', { board }),
  get: (id: string) => call<{ id: string; rev: number; board: unknown }>('GET', '/boards/' + id),
  save: (id: string, board: unknown, rev: number) => call<{ rev: number }>('PUT', '/boards/' + id, { board, rev }),
  remove: (id: string) => call<{ ok: true }>('DELETE', '/boards/' + id),
  share: (id: string) => call<{ token: string }>('POST', `/boards/${id}/share`),
  unshare: (id: string) => call<{ ok: true }>('DELETE', `/boards/${id}/share`),
  shared: (token: string) => call<{ board: unknown }>('GET', '/shared/' + token),
}
