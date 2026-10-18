import type { Board, Evidence } from './types'
import { EVIDENCE } from './types'

const clean = (s: string) => s.replace(/["\[\]\(\)\{\}<>`]/g, '').replace(/\s+/g, ' ').trim()

export function toMermaid(b: Board): string {
  const lines = ['flowchart LR']
  b.nodes.forEach((n) => lines.push(`  ${n.id}["${clean(n.data.title) || 'Untitled'}<br/>${n.data.evidence}"]`))
  b.edges.forEach((e) => lines.push(`  ${e.source} -->${e.label ? `|${clean(e.label)}|` : ''} ${e.target}`))
  return lines.join('\n')
}

export function fromMermaid(src: string, base: Board): Board {
  const ids = new Map<string, string>()
  const nodes: Board['nodes'] = []
  const edges: Board['edges'] = []
  const ensure = (id: string, label?: string) => {
    if (!ids.has(id)) {
      ids.set(id, label || id)
      const i = nodes.length
      nodes.push({
        id, type: 'card', position: { x: (i % 3) * 300, y: Math.floor(i / 3) * 230 },
        data: { kind: 'Step', title: label || id, evidence: 'Unknown', owner: '', next: '', record: '', note: '' },
      })
    } else if (label) {
      const n = nodes.find((x) => x.id === id)
      if (n) n.data.title = label
    }
  }
  const tok = /^\s*([A-Za-z0-9_]+)(?:\s*[\[\(\{]+"?([^"\]\)\}]*)"?[\]\)\}]+)?\s*$/
  for (const raw of src.split('\n')) {
    const line = raw.trim()
    if (!line || /^(flowchart|graph|%%|subgraph|end|classDef|style)/i.test(line)) continue
    const parts = line.split(/\s*-{2,}>(?:\|([^|]*)\|)?\s*/)
    // parts: [a, label, b, label, c ...]
    const items: string[] = []
    const labels: (string | undefined)[] = []
    for (let i = 0; i < parts.length; i += 2) {
      items.push(parts[i])
      labels.push(parts[i + 1])
    }
    const resolved = items.map((it) => {
      const m = tok.exec(it)
      if (!m) return null
      ensure(m[1], m[2] ? m[2].replace(/<br\s*\/?>.*$/i, '').trim() : undefined)
      return m[1]
    })
    for (let i = 0; i < resolved.length - 1; i++) {
      const a = resolved[i], b = resolved[i + 1]
      if (a && b) edges.push({ id: `m${edges.length}`, source: a, target: b, label: labels[i] })
    }
  }
  if (!nodes.length) throw new Error('No nodes found. Use lines like A[Start] --> B[Next].')
  return { ...base, nodes, edges, revision: base.revision + 1 }
}

export function validate(x: unknown): Board {
  const b = x as Board
  if (!b || typeof b !== 'object' || !Array.isArray(b.nodes) || !Array.isArray(b.edges)) throw new Error('Not a NahaLabs Canvas file.')
  if (b.nodes.length > 300 || b.edges.length > 600) throw new Error('Board is too large (limit 300 cards, 600 links).')
  const ids = new Set<string>()
  const nodes = b.nodes.map((n) => {
    if (!n || typeof n.id !== 'string' || !n.position || !n.data) throw new Error('A card is malformed.')
    ids.add(n.id)
    const ev: Evidence = EVIDENCE.includes(n.data.evidence) ? n.data.evidence : 'Unknown'
    const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, 600) : '')
    return {
      id: String(n.id).slice(0, 60), type: 'card' as const,
      position: { x: Number(n.position.x) || 0, y: Number(n.position.y) || 0 },
      data: { kind: s(n.data.kind), title: s(n.data.title), evidence: ev, owner: s(n.data.owner), next: s(n.data.next), record: s(n.data.record), note: s(n.data.note) },
    }
  })
  const edges = b.edges.filter((e) => ids.has(e.source) && ids.has(e.target)).map((e, i) => ({
    id: String(e.id || `e${i}`), source: e.source, target: e.target, label: typeof e.label === 'string' ? e.label.slice(0, 80) : undefined,
  }))
  return {
    id: String(b.id || 'imported').slice(0, 60), title: String(b.title || 'Imported map').slice(0, 120),
    purpose: String(b.purpose || '').slice(0, 600), product: String(b.product || 'General').slice(0, 60),
    revision: Number(b.revision) || 1, nodes, edges,
  }
}

export function toBrief(b: Board): string {
  const gaps = b.nodes.filter((n) => n.data.evidence === 'Unknown' || n.data.evidence === 'Claim')
  const noOwner = b.nodes.filter((n) => !n.data.owner.trim())
  const L: string[] = []
  L.push(`# ${b.title}`, '', `Product: ${b.product} | Revision ${b.revision} | Exported ${new Date().toISOString().slice(0, 10)}`, '')
  L.push(`Purpose: ${b.purpose.replace(/\*\*/g, '')}`, '')
  L.push('## Evidence summary')
  EVIDENCE.forEach((e) => L.push(`- ${e}: ${b.nodes.filter((n) => n.data.evidence === e).length}`))
  L.push('', '## Open gaps (Unknown or Claim)')
  if (!gaps.length) L.push('- None.')
  gaps.forEach((n) => L.push(`- ${n.data.title} [${n.data.evidence}] owner: ${n.data.owner || 'none'}. Next: ${n.data.next || 'not set'}`))
  L.push('', '## Cards without an owner')
  if (!noOwner.length) L.push('- None.')
  noOwner.forEach((n) => L.push(`- ${n.data.title}`))
  L.push('', '## All cards')
  b.nodes.forEach((n) => L.push(`- ${n.data.title} (${n.data.kind}, ${n.data.evidence})${n.data.record ? ` record: ${n.data.record}` : ''}${n.data.note ? ` note: ${n.data.note}` : ''}`))
  L.push('', '## Links')
  b.edges.forEach((e) => {
    const a = b.nodes.find((n) => n.id === e.source), t = b.nodes.find((n) => n.id === e.target)
    L.push(`- ${a?.data.title} -> ${t?.data.title}${e.label ? ` (${e.label})` : ''}`)
  })
  L.push('', 'Limits: this map is a view and a set of notes. Moving a card changes nothing in any product record and never counts as an approval.')
  return L.join('\n')
}

export function download(name: string, mime: string, content: string | Blob) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 2000)
}
