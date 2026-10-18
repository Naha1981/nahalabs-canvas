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
import { download, fromMermaid, toBrief, toMermaid, validate } from './io'

const MOBILE = typeof window !== 'undefined' && window.innerWidth <= 760
const KEY = 'nahalabs-canvas-v1'
const load = (): Board => {
  try { const s = localStorage.getItem(KEY); if (s) return validate(JSON.parse(s)) } catch { /* fall through */ }
  return TEMPLATES.council()
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
  const past = useRef<Board[]>([])
  const future = useRef<Board[]>([])
  const wrap = useRef<HTMLDivElement>(null)
  const rf = useReactFlow()

  useEffect(() => { localStorage.setItem(KEY, JSON.stringify(board)) }, [board])
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
  const useTemplate = (k: string) => { if (!k) return; past.current.push(board); future.current = []; setBoard(TEMPLATES[k]()); setSel(null); setTimeout(() => (MOBILE ? rf.setViewport({ x: 16, y: 16, zoom: 0.8 }) : rf.fitView({ padding: 0.15 })), 50) }

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
          <select aria-label="Start from a template" value="" onChange={(e) => useTemplate(e.target.value)}>
            <option value="">Templates</option>
            {Object.entries(TEMPLATE_NAMES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={addCard}>Add card</button>
          <button onClick={undo} aria-label="Undo">Undo</button>
          <button onClick={redo} aria-label="Redo">Redo</button>
          <button onClick={() => download(`${board.id}.json`, 'application/json', JSON.stringify(board, null, 2))}>Save JSON</button>
          <label className="btn">Open JSON<input type="file" accept="application/json,.json" hidden onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = '' }} /></label>
          <button onClick={exportPng}>PNG</button>
          <button className="primary" onClick={() => download(`${board.id}-brief.md`, 'text/markdown', toBrief(board))}>Export brief</button>
        </div>
      </header>

      <section className="intro">
        <input className="title-input" aria-label="Board title" value={board.title} onChange={(e) => commit((b) => ({ ...b, title: e.target.value.slice(0, 120) }), false)} />
        <p className="purpose"><Rich text={board.purpose || 'Add a purpose line for this map.'} /></p>
        <div className="chips" aria-label="Evidence summary">
          {counts.map(([e, n]) => <span key={e} className={`chip chip-${e.toLowerCase()}`} title={EVIDENCE_HELP[e]}>{e} {n}</span>)}
          <span className="chip chip-owner">{noOwner} without owner</span>
          <span className="rev">Revision {board.revision} · saved on this device</span>
        </div>
        <details className="limits" open={typeof window === 'undefined' || window.innerWidth > 760}>
          <summary><b>Limits</b> - what this map is not</summary>
          This map is a view and a set of notes. Moving a card changes no product record and never counts as an approval. Amounts and conclusions stay candidates until their evidence is Verified.
        </details>
      </section>

      <nav className="tabs" role="tablist">
        {(['map', 'list', 'text'] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={view === v ? 'on' : ''} onClick={() => setView(v)}>{v === 'map' ? 'Map' : v === 'list' ? 'List view' : 'Text'}</button>)}
      </nav>

      <main className="work">
        <div className="stage" ref={wrap} hidden={view !== 'map'}>
          <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodes} onEdgesChange={onEdges} onConnect={onConnect} connectionMode={ConnectionMode.Loose}
            onNodeClick={(_, n) => setSel(n.id)} onPaneClick={() => setSel(null)} {...(MOBILE ? { defaultViewport: { x: 16, y: 16, zoom: 0.8 } } : { fitView: true, fitViewOptions: { padding: 0.15 } })} minZoom={0.2} maxZoom={1.8}
            deleteKeyCode={['Backspace', 'Delete']} proOptions={{ hideAttribution: true }}>
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

        <aside className={`inspector ${selected ? 'open' : ''}`} aria-label="Card details">
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
        </aside>
      </main>
      <div className="toast" role="status" aria-live="polite">{msg}</div>
    </div>
  )
}
export default function App() { return <ReactFlowProvider><Inner /></ReactFlowProvider> }
