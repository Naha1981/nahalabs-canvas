export type Evidence = 'Verified' | 'Observed' | 'Claim' | 'Inference' | 'Unknown'
export const EVIDENCE: Evidence[] = ['Verified', 'Observed', 'Claim', 'Inference', 'Unknown']
export const EVIDENCE_HELP: Record<Evidence, string> = {
  Verified: 'Seen directly in a record, document or source we checked.',
  Observed: 'Seen happening, for example on screen or in a log.',
  Claim: 'Someone said so. Not checked yet.',
  Inference: 'Our own judgement from the evidence we have.',
  Unknown: 'Not established. A gap to close.',
}
export type CardData = {
  title: string
  kind: string
  evidence: Evidence
  owner: string
  next: string
  record: string
  note: string
  [k: string]: unknown
}
export type Board = {
  id: string
  title: string
  purpose: string
  product: string
  revision: number
  nodes: { id: string; type: 'card'; position: { x: number; y: number }; data: CardData }[]
  edges: { id: string; source: string; target: string; label?: string }[]
}
