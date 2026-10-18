import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow, ReactFlowProvider, ConnectionMode, Background, Controls, MiniMap, Handle, Position, MarkerType,
  applyNodeChanges, applyEdgeChanges, addEdge, useReactFlow,
  type NodeProps, type NodeChange, type EdgeChange, type Connection,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toPng } from 'html-to-image'
import { EVIDENCE, EVIDENCE_HELP, type Board, type CardData, type Evidence } from './types'
import { TEMPLATES, TEMPLATE_NAMES } from './templates'
import { api, ApiError, type BoardRow, type Org, type Member } from './api'
import { download, fromMermaid, toBrief, toMermaid, validate } from './io'

const MOBILE = typeof window !== 'undefined' && window.innerWidth <= 760
const KEY = 'nahalabs-canvas-v1'
const stack = (b: Board): Board => MOBILE ? { ...b, nodes: b.nodes.map((n, i) => ({ ...n, position: { x: 0, y: i * 200 } })) } : b
const load = (): Board => {
  try { const s = localStorage.getItem(KEY); if (s) return validate(JSON.parse(s)) } catch { /* fall through */ }
  return stack(TEMPLATES.council())
}

function Rich({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g)
  return <>{parts.map((p, i) => p.startsWith('**') ? <b key={i}>{p.slice(2, -2)}</b> : <span key={i}>{p}</span>)}</>
}

const SIDES: [Position, string][] = [[Position.Left, 'l'], [Position.Right, 'r'], [Position.Top, 't'], [Position.Bottom, 'b']]
function CardNode({ data, selected }: NodeProps) {
  const d = data as CardData
  return (
    <div className={`card ev-${d.evidence.toLowerCase()} ${selected ? 'sel' : ''}`} role="group" aria-label={`${d.title}, ${d.evidence}`}>
      {SIDES.map(([pos, k]) => <Handle key={'t' + k} id={'t' + k} type="target" position={pos} />)}
      <div className="card-top">
        <span className="kind">{d.kind || 'Card'}</span>
        <span className={`chip chip-${d.evidence.toLowerCase()}`}>{d.evidence}</span>
      </div>
      <div className="card-title">{d.title || 'Untitled'}</div>
      <div className="card-meta">{d.owner ? <>Owner: <b>{d.owner}</b></> : <i>No owner yet</i>}</div>
      {d.next && <div className="card-next">Next: {d.next}</div>}
      {d.note && <div className="card-note">{d.note}</div>}
      {SIDES.map(([pos, k]) => <Handle key={'s' + k} id={'s' + k} type="source" position={pos} />)}
    </div>
  )
}
const nodeTypes = { card: CardNode }

function Inner() {
  const [board, setBoard] = useState<Board>(load)
  const [sel, setSel] = useState<string | null>(null)
  const [view, setView] = useState<'map' | 'list' | 'text'>('map')
  const [msg, setMsg] = useState('')
  const [text, setText] = useState('')
  const [user, setUser] = useState<string | null>(null)
  const [dlg, setDlg] = useState<null | 'auth' | 'boards' | 'members'>(null)
  const [orgs, setOrgs] = useState<Org[]>([])
  const [orgId, setOrgId] = useState<string | null>(() => localStorage.getItem(KEY + '-org'))
  const [joinTok, setJoinTok] = useState<string | null>(null)
  const [joinInfo, setJoinInfo] = useState<{ org: string; role: string } | null>(null)
  const [cloud, setCloud] = useState<{ id: string; rev: number } | null>(() => { try { return JSON.parse(localStorage.getItem(KEY + '-cloud') || 'null') } catch { return null } })
  const [sync, setSync] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [ro, setRo] = useState(false)
  const [shareTok, setShareTok] = useState<string | null>(null)
  const past = useRef<Board[]>([])
  const future = useRef<Board[]>([])
  const wrap = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()

  useEffect(() => { if (!ro) localStorage.setItem(KEY, JSON.stringify(board)) }, [board, ro])
  useEffect(() => { localStorage.setItem(KEY + '-cloud', JSON.stringify(cloud)) }, [cloud])
  const applyOrgs = (list: Org[], prefer?: string) => {
    setOrgs(list)
    const keep = prefer && list.find((o) => o.id === prefer) ? prefer : list.find((o) => o.id === orgId) ? orgId : list[0]?.id ?? null
    setOrgId(keep); if (keep) localStorage.setItem(KEY + '-org', keep)
  }
  const activeOrg = orgs.find((o) => o.id === orgId) ?? null
  useEffect(() => { api.me().then((r) => { setUser(r.user?.email ?? null); applyOrgs(r.orgs || []) }).catch(() => {}) }, []) // eslint-disable-line
  useEffect(() => {
    const m = /^#\/join\/([A-Za-z0-9]+)$/.exec(location.hash)
    if (m) { setJoinTok(m[1]); api.joinPreview(m[1]).then(setJoinInfo).catch((e) => flash((e as Error).message)) }
  }, []) // eslint-disable-line
  const doJoin = async (authed = !!user) => {
    if (!joinTok) return
    if (!authed) { setDlg('auth'); return }
    try { const r = await api.join(joinTok); applyOrgs(r.orgs, r.joined); setJoinTok(null); setJoinInfo(null); history.replaceState(null, '', location.pathname); setDlg('boards'); flash('You joined the organisation.') }
    catch (e) { flash((e as Error).message) }
  }
  useEffect(() => {
    const t = /^#\/t\/([a-z]+)$/.exec(location.hash)
    if (t && TEMPLATES[t[1]]) { setBoard(stack(TEMPLATES[t[1]]())); setCloud(null); setTimeout(() => (MOBILE ? rf.setViewport({ x: 16, y: 16, zoom: 0.8 }) : rf.fitView({ padding: 0.15 })), 80); return }
    const m = /^#\/s\/([A-Za-z0-9]+)$/.exec(location.hash)
    if (!m) return
    api.shared(m[1]).then((r) => { setBoard(validate(r.board)); setRo(true); setCloud(null); setTimeout(() => rf.fitView({ padding: 0.15 }), 80) }).catch((e) => flash((e as Error).message))
  }, []) // eslint-disable-line
  // autosave to account
  const lastSaved = useRef(0)
  useEffect(() => {
    if (!cloud || !user || ro) return
    if (lastSaved.current === board.revision) return
    setSync('saving')
    const t = setTimeout(async () => {
      try {
        const r = await api.save(cloud.id, board, cloud.rev)
        lastSaved.current = board.revision
        setCloud({ id: cloud.id, rev: r.rev }); setSync('saved')
      } catch (e) { setSync('error'); flash((e as Error).message) }
    }, 1200)
    return () => clearTimeout(t)
  }, [board, cloud, user, ro])
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500) }

  const commit = useCallback((fn: (b: Board) => Board, record = true) => {
    setBoard((b) => {
      if (record) { past.current.push(b); if (past.current.length > 60) past.current.shift(); future.current = [] }
      return { ...fn(b), revision: b.revision + (record ? 1 : 0) }
    })
  }, [])
  const undo = () => { const p = past.current.pop(); if (p) { setBoard((b) => { future.current.push(b); return p }) } }
  const redo = () => { const f = future.current.pop(); if (f) { setBoard((b) => { past.current.push(b); return f }) } }

  const nodes = useMemo(() => board.nodes.map((n) => ({ ...n, selected: n.id === sel })), [board.nodes, sel])
  const edges = useMemo(() => board.edges.map((e) => {
    const a = board.nodes.find((n) => n.id === e.source)?.position, b = board.nodes.find((n) => n.id === e.target)?.position
    let sh = 'sr', th = 'tl'
    if (a && b) {
      const dx = b.x - a.x, dy = b.y - a.y
      if (Math.abs(dx) >= Math.abs(dy) * 0.6) { if (dx < 0) { sh = 'sl'; th = 'tr' } } else if (dy > 0) { sh = 'sb'; th = 'tt' } else { sh = 'st'; th = 'tb' }
    }
    return { ...e, sourceHandle: sh, targetHandle: th, markerEnd: { type: MarkerType.ArrowClosed, color: '#8a7a55' }, style: { stroke: '#8a7a55', strokeWidth: 1.6 }, labelStyle: { fontSize: 12 } }}), [board.edges, board.nodes])

  const onNodes = useCallback((ch: NodeChange[]) => {
    const structural = ch.some((c) => c.type === 'remove')
    const dragEnd = ch.some((c) => c.type === 'position' && c.dragging === false)
    commit((b) => ({ ...b, nodes: applyNodeChanges(ch, b.nodes as never) as never }), structural || dragEnd)
    ch.forEach((c) => { if (c.type === 'select' && c.selected) setSel(c.id) })
    if (structural) setSel(null)
  }, [commit])
  const onEdges = useCallback((ch: EdgeChange[]) => commit((b) => ({ ...b, edges: applyEdgeChanges(ch, b.edges as never) as never }), ch.some((c) => c.type === 'remove')), [commit])
  const onConnect = useCallback((c: Connection) => commit((b) => ({ ...b, edges: addEdge({ source: c.source, target: c.target, id: `e${Date.now()}` }, b.edges as never) as never })), [commit])

  const selected = board.nodes.find((n) => n.id === sel)
  const patch = (p: Partial<CardData>) => sel && commit((b) => ({ ...b, nodes: b.nodes.map((n) => n.id === sel ? { ...n, data: { ...n.data, ...p } } : n) }))
  const addCard = () => {
    const id = `n${Date.now()}`
    const c = rf.screenToFlowPosition({ x: (wrap.current?.getBoundingClientRect().left ?? 0) + 120, y: (wrap.current?.getBoundingClientRect().top ?? 0) + 120 })
    commit((b) => ({ ...b, nodes: [...b.nodes, { id, type: 'card', position: c, data: { kind: 'Step', title: 'New card', evidence: 'Unknown', owner: '', next: '', record: '', note: '' } }] }))
    setSel(id)
  }
  const del = () => { if (sel) { commit((b) => ({ ...b, nodes: b.nodes.filter((n) => n.id !== sel), edges: b.edges.filter((e) => e.source !== sel && e.target !== sel) })); setSel(null) } }
  const useTemplate = (k: string) => { if (!k || ro) return; setCloud(null); setSync('idle'); past.current.push(board); future.current = []; setBoard(stack(TEMPLATES[k]())); setSel(null); setTimeout(() => (MOBILE ? rf.setViewport({ x: 16, y: 16, zoom: 0.8 }) : rf.fitView({ padding: 0.15 })), 50) }

  const saveToAccount = async () => {
    if (!user) { setDlg('auth'); return }
    if (!activeOrg || activeOrg.role === 'viewer') { flash('You have view-only access in this organisation. Pick another one or make your own.'); return }
    try { const r = await api.create(board, activeOrg.id); lastSaved.current = board.revision; setCloud({ id: r.id, rev: r.rev }); setSync('saved'); flash('Saved to your account.') }
    catch (e) { flash((e as Error).message) }
  }
  const openCloud = async (id: string) => {
    try { const r = await api.get(id); const b = validate(r.board); past.current = []; setRo(r.role === 'viewer'); if (r.org) { setOrgId(r.org); localStorage.setItem(KEY + '-org', r.org) } setBoard(b); lastSaved.current = b.revision; setCloud({ id: r.id, rev: r.rev }); setSync('saved'); setDlg(null); setSel(null); setTimeout(() => (MOBILE ? rf.setViewport({ x: 16, y: 16, zoom: 0.8 }) : rf.fitView({ padding: 0.15 })), 80) }
    catch (e) { flash((e as Error).message) }
  }
  const copyShared = () => { setRo(false); setCloud(null); setSync('idle'); history.replaceState(null, '', location.pathname); setBoard((b) => ({ ...b, id: 'copy' + Date.now() })); flash('This is now your own editable copy on this device.') }
  const counts = EVIDENCE.map((e) => [e, board.nodes.filter((n) => n.data.evidence === e).length] as const)
  const noOwner = board.nodes.filter((n) => !n.data.owner.trim()).length

  const exportPng = async () => {
    const el = wrap.current?.querySelector('.react-flow__viewport') as HTMLElement | null
    if (!el) return
    try {
      const r = rf.getNodesBounds(rf.getNodes()); const w = 1600, h = Math.max(600, Math.round(w * (r.height + 120) / (r.width + 120)))
      const vp = rf.getViewport()
      const scale = Math.min(w / (r.width + 120), h / (r.height + 120))
      const url = await toPng(el, { backgroundColor: '#fbf8f1', width: w, height: h, style: { width: `${w}px`, height: `${h}px`, transform: `translate(${-r.x * scale + 60 * scale}px, ${-r.y * scale + 60 * scale}px) scale(${scale})` } })
      void vp
      const a = document.createElement('a'); a.href = url; a.download = `${board.id}.png`; a.click()
    } catch { flash('PNG export failed in this browser. Use JSON or the brief.') }
  }
  const importFile = (f: File | undefined) => {
    if (!f) return
    f.text().then((t) => {
      try { const b = validate(JSON.parse(t)); past.current.push(board); setBoard(b); flash(`Imported ${b.nodes.length} cards.`); setTimeout(() => (MOBILE ? rf.setViewport({ x: 16, y: 16, zoom: 0.8 }) : rf.fitView({ padding: 0.15 })), 50) }
      catch (e) { flash((e as Error).message || 'Could not read that file.') }
    })
  }
  const applyText = () => {
    try { const b = fromMermaid(text, board); past.current.push(board); setBoard(b); setView('map'); flash(`Built ${b.nodes.length} cards from text.`); setTimeout(() => rf.fitView({ padding: 0.15 }), 80) }
    catch (e) { flash((e as Error).message) }
  }
  useEffect(() => { if (view === 'text') setText(toMermaid(board)) }, [view]) // eslint-disable-line

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo() }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  })

  return (
    <div className="app">
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden>N</span><div><div className="bname">NahaLabs Canvas</div><div className="bsub">Visual systems maps with evidence labels</div></div></div>
        <div className="tools" role="toolbar" aria-label="Board actions">
          {!ro && (user
            ? <button onClick={() => setDlg('boards')}>My boards</button>
            : <button className="gold" onClick={() => setDlg('auth')}>Sign up free</button>)}
          {!ro && <>
            <select aria-label="Start from a template" value="" onChange={(e) => useTemplate(e.target.value)}>
              <option value="">Templates</option>
              {Object.entries(TEMPLATE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
            <button onClick={addCard}>Add card</button>
            <button onClick={undo} aria-label="Undo">Undo</button>
            <button onClick={redo} aria-label="Redo">Redo</button>
          </>}
          {ro && <button className="primary" onClick={copyShared}>Make my own copy</button>}
          <button onClick={() => download(`${board.id}.json`, 'application/json', JSON.stringify(board, null, 2))}>Save JSON</button>
          {!ro && <label className="btn">Open JSON<input type="file" accept="application/json,.json" hidden onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} /></label>}
          <button onClick={exportPng}>PNG</button>
          <button className={ro ? '' : 'primary'} onClick={() => download(`${board.id}-brief.md`, 'text/markdown', toBrief(board))}>Export brief</button>
        </div>
      </header>

      <section className="intro">
        <input className="title-input" aria-label="Board title" value={board.title} onChange={(e) => commit((b) => ({ ...b, title: e.target.value.slice(0, 120) }), false)} />
        <p className="purpose"><Rich text={board.purpose || 'Add a purpose line for this map.'} /></p>
        <div className="chips" aria-label="Evidence summary">
          {counts.map(([e, n]) => <span key={e} className={`chip chip-${e.toLowerCase()}`} title={EVIDENCE_HELP[e]}>{e} {n}</span>)}
          <span className="chip chip-owner">{noOwner} without owner</span>
          <span className="rev">Revision {board.revision} · {ro ? "shared, view only" : cloud && user ? (sync === "saving" ? "saving to your account…" : sync === "error" ? "not saved to your account, retrying on next change" : "saved to your account") : "saved on this device"}</span>
        </div>
        <details className="limits" open={typeof window === 'undefined' || window.innerWidth > 760}>
          <summary><b>Limits</b> - what this map is not</summary>
          This map is a view and a set of notes. Moving a card changes no product record and never counts as an approval. Amounts and conclusions stay candidates until their evidence is Verified.
        </details>
      </section>

      {joinTok && joinInfo && <div className="joinbar" role="status"><span>You were invited to <b>{joinInfo.org}</b> as {joinInfo.role}.</span><button className="primary" onClick={() => doJoin()}>{user ? 'Join organisation' : 'Sign up or log in to join'}</button></div>}
      <nav className="tabs" role="tablist">
        {(['map', 'list', 'text'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'map' ? 'Map' : v === 'list' ? 'List view' : 'Text'}</button>)}
      </nav>

      <main className="work">
        <div className="stage" ref={wrap} hidden={view !== 'map'}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodes} onEdgesChange={onEdges} onConnect={onConnect} connectionMode={ConnectionMode.Loose}
            onNodeClick={(_, n) => setSel(n.id)} onPaneClick={() => setSel(null)} nodesDraggable={!ro} nodesConnectable={!ro} {...(MOBILE ? { defaultViewport: { x: 16, y: 16, zoom: 0.8 } } : { fitView: true, fitViewOptions: { padding: 0.15 } })} minZoom={0.2} maxZoom={1.8}
            deleteKeyCode={ro ? null : ['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
            <Background color="#e5dcc6" gap={22} />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable className="mm" />
          </ReactFlow>
        </div>

        {view === 'list' && (
          <div className="listview">
            <table>
              <thead><tr><th>Card</th><th>Kind</th><th>Evidence</th><th>Owner</th><th>Next action</th></tr></thead>
              <tbody>{board.nodes.map((n) => (
                <tr key={n.id} className={n.id === sel ? 'on' : ''} onClick={() => setSel(n.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setSel(n.id)}>
                  <td data-l="Card">{n.data.title}</td><td data-l="Kind">{n.data.kind}</td>
                  <td data-l="Evidence"><span className={`chip chip-${n.data.evidence.toLowerCase()}`}>{n.data.evidence}</span></td>
                  <td data-l="Owner">{n.data.owner || <i>none</i>}</td><td data-l="Next">{n.data.next}</td>
                </tr>))}</tbody>
            </table>
            <h3>Links</h3>
            <ul>{board.edges.map((e) => <li key={e.id}>{board.nodes.find((n) => n.id === e.source)?.data.title} → {board.nodes.find((n) => n.id === e.target)?.data.title}{e.label ? ` (${e.label})` : ''}</li>)}</ul>
          </div>
        )}

        {view === 'text' && (
          <div className="textview">
            <p>Edit as text, then build. One link per line, like <code>A[Start] --&gt; B[Next]</code>. Rebuilding replaces the current cards and resets evidence to Unknown.</p>
            <textarea aria-label="Diagram text" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
            <div className="row">
              <button className="primary" onClick={applyText}>Build map from text</button>
              <button onClick={() => { navigator.clipboard?.writeText(toMermaid(board)); flash('Copied.') }}>Copy current as text</button>
              <button onClick={() => download(`${board.id}.mmd`, 'text/plain', toMermaid(board))}>Save .mmd</button>
            </div>
          </div>
        )}

        <aside className={`inspector ${selected ? 'open' : ''}`} aria-label="Card details"><fieldset disabled={ro} className="fs">
          {selected ? (
            <>
              <div className="ins-head"><b>Card details</b><button onClick={() => setSel(null)} aria-label="Close details">Close</button></div>
              <label>Title<input value={selected.data.title} onChange={(e) => patch({ title: e.target.value.slice(0, 120) })} /></label>
              <label>Kind<input value={selected.data.kind} onChange={(e) => patch({ kind: e.target.value.slice(0, 40) })} /></label>
              <label>Evidence
                <select value={selected.data.evidence} onChange={(e) => patch({ evidence: e.target.value as Evidence })}>{EVIDENCE.map((x) => <option key={x}>{x}</option>)}</select>
              </label>
              <small>{EVIDENCE_HELP[selected.data.evidence]}</small>
              <label>Owner<input value={selected.data.owner} onChange={(e) => patch({ owner: e.target.value.slice(0, 80) })} /></label>
              <label>Next action<input value={selected.data.next} onChange={(e) => patch({ next: e.target.value.slice(0, 200) })} /></label>
              <label>Record or source reference<input placeholder="Case ID, invoice number, link" value={selected.data.record} onChange={(e) => patch({ record: e.target.value.slice(0, 200) })} /></label>
              <label>Note<textarea value={selected.data.note} onChange={(e) => patch({ note: e.target.value.slice(0, 600) })} /></label>
              <button className="danger" onClick={del}>Delete card</button>
            </>
          ) : <p className="hint">Select a card to edit its owner, evidence and next action. Drag from one card's right dot to another's left dot to link them.</p>}
        </fieldset></aside>
      </main>
      {dlg === 'auth' && <AuthDialog onClose={() => setDlg(null)} onDone={(e) => { setUser(e); api.me().then((r) => applyOrgs(r.orgs || [])); if (joinTok) { setDlg(null); setTimeout(() => doJoin(true), 200) } else { setDlg(null); flash('Signed in. Use My boards, or save this board to your account.') } }} />}
      {dlg === 'boards' && user && activeOrg && <BoardsDialog email={user} orgs={orgs} org={activeOrg} onOrg={(id) => { setOrgId(id); localStorage.setItem(KEY + '-org', id) }} onOrgs={applyOrgs} onMembers={() => setDlg('members')} current={cloud?.id ?? null} onClose={() => setDlg(null)} onOpen={openCloud}
        onSaveNew={saveToAccount} onLogout={async () => { await api.logout().catch(() => {}); setUser(null); setOrgs([]); setCloud(null); setSync('idle'); setDlg(null) }}
        onDeleted={(id) => { if (cloud?.id === id) setCloud(null) }} shareTok={shareTok} setShareTok={setShareTok} flash={flash} />}
      {dlg === 'members' && activeOrg && <MembersDialog org={activeOrg} onClose={() => setDlg('boards')} flash={flash} onOrgs={applyOrgs} />}
      <div className="toast" role="status" aria-live="polite">{msg}</div>
    </div>
  )
}

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h) }, [onClose])
  return <div className="modal-bg" onClick={onClose}><div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
    <div className="ins-head"><b>{title}</b><button onClick={onClose}>Close</button></div>{children}</div></div>
}
function AuthDialog({ onClose, onDone }: { onClose: () => void; onDone: (email: string) => void }) {
  const [mode, setMode] = useState<'signup' | 'login'>('signup')
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [wn, setWn] = useState(''); const [err, setErr] = useState(''); const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('')
    try { const r = mode === 'signup' ? await api.signup(email, pw, wn.trim() || undefined) : await api.login(email, pw); onDone(r.user.email) }
    catch (x) { setErr(x instanceof ApiError ? x.message : 'Something went wrong.') } finally { setBusy(false) }
  }
  return <Modal title={mode === 'signup' ? 'Create your free account' : 'Log in'} onClose={onClose}>
    <p className="hint">{mode === 'signup' ? 'Anyone can sign up. Save boards to your account, open them on any device and share a view-only link.' : 'Welcome back.'}</p>
    <form onSubmit={submit} className="form">
      <label>Email<input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} required minLength={8} value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {mode === 'signup' && <label>Organisation or workspace name (optional)<input autoComplete="organization" maxLength={80} value={wn} onChange={(e) => setWn(e.target.value)} placeholder="Your company or team" /></label>}
      {mode === 'signup' && <small>At least 8 characters. There is no password reset yet, so keep it somewhere safe.</small>}
      {err && <div className="err" role="alert">{err}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Log in'}</button>
    </form>
    <button className="link" onClick={() => { setMode(mode === 'signup' ? 'login' : 'signup'); setErr('') }}>{mode === 'signup' ? 'I already have an account' : 'Create a free account'}</button>
  </Modal>
}
function BoardsDialog(p: { email: string; orgs: Org[]; org: Org; onOrg: (id: string) => void; onOrgs: (l: Org[], prefer?: string) => void; onMembers: () => void; current: string | null; onClose: () => void; onOpen: (id: string) => void; onSaveNew: () => void; onLogout: () => void; onDeleted: (id: string) => void; shareTok: string | null; setShareTok: (t: string | null) => void; flash: (m: string) => void }) {
  const [rows, setRows] = useState<BoardRow[] | null>(null)
  const load = () => api.list(p.org.id).then((r) => setRows(r.boards)).catch((e) => p.flash((e as Error).message))
  useEffect(() => { setRows(null); load() }, [p.org.id]) // eslint-disable-line
  const canWrite = p.org.role !== 'viewer'
  const newOrg = async () => { const n = prompt('Name for the new organisation'); if (!n) return; try { const r = await api.createOrg(n); p.onOrgs(r.orgs, r.id) } catch (e) { p.flash((e as Error).message) } }
  const link = (t: string) => `${location.origin}${location.pathname}#/s/${t}`
  const share = async (r: BoardRow) => { try { const x = await api.share(r.id); await navigator.clipboard?.writeText(link(x.token)).catch(() => {}); p.flash('View-only link copied.'); load() } catch (e) { p.flash((e as Error).message) } }
  const unshare = async (r: BoardRow) => { await api.unshare(r.id).catch(() => {}); p.flash('Link switched off.'); load() }
  const del = async (r: BoardRow) => { if (!confirm(`Delete "${r.title}"? This cannot be undone.`)) return; await api.remove(r.id).catch(() => {}); p.onDeleted(r.id); load() }
  return <Modal title="My boards" onClose={p.onClose}>
    <p className="hint">Signed in as <b>{p.email}</b>.</p>
    <div className="row">
      <select aria-label="Organisation" value={p.org.id} onChange={(e) => p.onOrg(e.target.value)}>{p.orgs.map((o) => <option key={o.id} value={o.id}>{o.name} ({o.role})</option>)}</select>
      <button onClick={p.onMembers}>People</button><button onClick={newOrg}>New organisation</button>
    </div>
    <div className="row">{canWrite ? <button className="primary" onClick={() => { p.onSaveNew(); setTimeout(load, 700) }}>Save current board to {p.org.name}</button> : <span className="hint">You have view-only access in this organisation.</span>}<button onClick={p.onLogout}>Log out</button></div>
    <div className="blist">
      {rows === null ? <p className="hint">Loading…</p> : rows.length === 0 ? <p className="hint">No saved boards yet. Save the current one to start.</p> :
        rows.map((r) => <div key={r.id} className={`brow ${r.id === p.current ? 'on' : ''}`}>
          <div className="bt"><b>{r.title}</b><small>{new Date(r.updated).toLocaleString()}{r.id === p.current ? ' · open now' : ''}</small></div>
          <div className="row"><button onClick={() => p.onOpen(r.id)}>Open</button>
            {!canWrite ? null : r.share ? <><button onClick={() => navigator.clipboard?.writeText(link(r.share!)).then(() => p.flash('Link copied.'))}>Copy link</button><button onClick={() => unshare(r)}>Stop sharing</button></> : <button onClick={() => share(r)}>Share</button>}
            {canWrite && <button className="danger" onClick={() => del(r)}>Delete</button>}</div>
        </div>)}
    </div>
  </Modal>
}
function MembersDialog({ org, onClose, flash, onOrgs }: { org: Org; onClose: () => void; flash: (m: string) => void; onOrgs: (l: Org[], prefer?: string) => void }) {
  const [data, setData] = useState<{ members: Member[]; you: string; links: { token: string; role: string }[] } | null>(null)
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const owner = org.role === 'owner'
  const load = () => api.members(org.id).then(setData).catch((e) => flash((e as Error).message))
  useEffect(() => { load() }, [org.id]) // eslint-disable-line
  const link = (t: string) => `${location.origin}${location.pathname}#/join/${t}`
  const act = async (f: () => Promise<unknown>, m?: string) => { try { await f(); if (m) flash(m); load() } catch (e) { flash((e as Error).message) } }
  const rename = () => { const n = prompt('Organisation name', org.name); if (n) act(async () => onOrgs((await api.renameOrg(org.id, n)).orgs, org.id), 'Renamed.') }
  return <Modal title={org.name} onClose={onClose}>
    <p className="hint">You are {org.role === 'owner' ? 'an owner' : 'an ' + org.role}. {owner ? 'Owners manage people. Editors change boards. Viewers can only read.' : 'Only owners can change people.'}</p>
    {owner && <div className="row"><button onClick={rename}>Rename</button></div>}
    <div className="blist">{!data ? <p className="hint">Loading…</p> : data.members.map((m) => <div key={m.id} className="brow">
      <div className="bt"><b>{m.email}{m.id === data.you ? ' (you)' : ''}</b><small>{m.role}</small></div>
      <div className="row">
        {owner && <select aria-label={'Role for ' + m.email} value={m.role} onChange={(e) => act(() => api.setRole(org.id, m.id, e.target.value), 'Role changed.')}><option>owner</option><option>editor</option><option>viewer</option></select>}
        {(owner || m.id === data.you) && <button className="danger" onClick={() => confirm(m.id === data.you ? 'Leave this organisation?' : 'Remove this person?') && act(async () => { await api.removeMember(org.id, m.id); if (m.id === data.you) { onOrgs((await api.me()).orgs); onClose() } }, m.id === data.you ? 'You left.' : 'Removed.')}>{m.id === data.you ? 'Leave' : 'Remove'}</button>}
      </div></div>)}</div>
    {owner && data && <div className="blist"><b>Join link</b>
      <p className="hint">Anyone with the link can sign up and join with the role you pick. It expires in 14 days and you can switch it off.</p>
      <div className="row"><select aria-label="Role for joiners" value={role} onChange={(e) => setRole(e.target.value as 'editor' | 'viewer')}><option value="editor">Editor</option><option value="viewer">Viewer</option></select>
        <button onClick={() => act(async () => { const r = await api.joinLink(org.id, role); await navigator.clipboard?.writeText(link(r.token)).catch(() => {}) }, 'New link copied.')}>{data.links.length ? 'Replace and copy link' : 'Create and copy link'}</button>
        {data.links.length > 0 && <><button onClick={() => navigator.clipboard?.writeText(link(data.links[0].token)).then(() => flash('Link copied.'))}>Copy link</button><button onClick={() => act(() => api.joinLinkOff(org.id), 'Link switched off.')}>Switch off</button></>}</div>
      {data.links.length > 0 && <small>Active link gives {data.links[0].role} access.</small>}</div>}
  </Modal>
}
export default function App() { return <ReactFlowProvider><Inner /></ReactFlowProvider> }
