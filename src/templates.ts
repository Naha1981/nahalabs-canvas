import type { Board, CardData, Evidence } from './types'

type Spec = [id: string, kind: string, title: string, ev: Evidence, owner: string, next: string, note?: string]
function build(
  id: string, title: string, product: string, purpose: string,
  specs: Spec[], cols: number, links: [string, string, string?][],
): Board {
  return {
    id, title, product, purpose, revision: 1,
    nodes: specs.map((s, i) => ({
      id: s[0], type: 'card' as const,
      position: { x: (Math.floor(i / cols) % 2 ? cols - 1 - (i % cols) : i % cols) * 300, y: Math.floor(i / cols) * 230 },
      data: { kind: s[1], title: s[2], evidence: s[3], owner: s[4], next: s[5], record: '', note: s[6] ?? '' } as CardData,
    })),
    edges: links.map(([a, b, l], i) => ({ id: `e${i}`, source: a, target: b, label: l })),
  }
}

export const TEMPLATES: Record<string, () => Board> = {
  council: () => build('council', 'NahaLabs Council stage map', 'Council',
    'Shows where every idea sits from **Idea to Learning**, who owns it and what evidence is missing. Next action: close each **Unknown** before the Approval stage.',
    [
      ['s1', 'Stage', 'Idea', 'Claim', 'Thabiso', 'Write the one-line problem'],
      ['s2', 'Stage', 'Council', 'Inference', 'Instinct', 'Record the decision and its risks'],
      ['s3', 'Stage', 'Research', 'Unknown', 'Instinct', 'List sources with dates'],
      ['s4', 'Stage', 'Evidence', 'Unknown', 'Instinct', 'Label every fact with one of five tags'],
      ['s5', 'Stage', 'Blueprint', 'Inference', 'Instinct', 'Draft the design and the limits'],
      ['s6', 'Stage', 'Prototype', 'Unknown', 'Instinct', 'Build and test on a phone'],
      ['s7', 'Gate', 'Approval', 'Unknown', 'Thabiso', 'Thabiso approves in his own words', 'Moving this card never counts as approval.'],
      ['s8', 'Stage', 'Production', 'Unknown', 'Instinct', 'Deploy only after approval'],
      ['s9', 'Stage', 'Measurement', 'Unknown', 'Instinct', 'Pick one measurable outcome'],
      ['s10', 'Stage', 'Learning', 'Unknown', 'Thabiso', 'Write what changed and why'],
    ], 4,
    [['s1','s2'],['s2','s3'],['s3','s4'],['s4','s5'],['s5','s6'],['s6','s7'],['s7','s8'],['s8','s9'],['s9','s10']]),

  cargoiq: () => build('cargoiq', 'CargoIQ case map', 'CargoIQ',
    'Shows what a **demurrage or detention claim** rests on and what is missing. Next action: resolve each **conflict** before the claim pack is drafted. Amounts stay candidates until supported.',
    [
      ['c1', 'Event', 'Shipment event', 'Verified', 'Case owner', 'Attach the bill of lading'],
      ['c2', 'Event', 'Delay or charge detected', 'Observed', 'Case owner', 'Link the invoice line'],
      ['c3', 'Evidence', 'Source documents gathered', 'Verified', 'Case owner', 'Hash and store each file'],
      ['c4', 'Conflict', 'Evidence conflicts', 'Unknown', 'Case owner', 'Resolve or record each contradiction', 'Blocks the claim pack while open.'],
      ['c5', 'Assessment', 'Responsibility assessed', 'Inference', 'Case owner', 'State who caused the delay and why'],
      ['c6', 'Calculation', 'Candidate recoverable amount', 'Inference', 'Case owner', 'Show inputs and free days used', 'Candidate only. Not a legal entitlement.'],
      ['c7', 'Output', 'Draft claim pack', 'Unknown', 'Case owner', 'Generate after conflicts are closed'],
      ['c8', 'Review', 'Customer review', 'Unknown', 'Customer', 'Customer signs off or disputes'],
      ['c9', 'Outcome', 'Outcome and recovery', 'Unknown', 'Case owner', 'Record what was actually recovered'],
    ], 3,
    [['c1','c2'],['c2','c3'],['c3','c4'],['c4','c5'],['c5','c6'],['c6','c7'],['c7','c8'],['c8','c9']]),

  flavourly: () => build('flavourly', 'Flavourly customer journey', 'Flavourly',
    'Shows how a guest moves from **first enquiry to repeat visit** at each branch. Next action: give every step an **owner** and one measurable outcome. Sample figures are labelled as samples.',
    [
      ['f1', 'Step', 'Customer discovery', 'Inference', 'Branch manager', 'Pick the main discovery channel'],
      ['f2', 'Step', 'Menu or offer', 'Claim', 'Branch manager', 'Confirm the current menu'],
      ['f3', 'Step', 'WhatsApp enquiry', 'Unknown', 'Front of house', 'Check the live integration before promising it', 'Drawing a step does not prove the integration works.'],
      ['f4', 'Step', 'Booking or order', 'Unknown', 'Front of house', 'Record how many enquiries convert'],
      ['f5', 'Step', 'Loyalty points', 'Unknown', 'Owner', 'Decide the reward rule'],
      ['f6', 'Step', 'Repeat visit', 'Inference', 'Owner', 'Set a 30 day return target'],
      ['f7', 'Step', 'Review or referral', 'Unknown', 'Branch manager', 'Ask at the table, then log it'],
    ], 4,
    [['f1','f2'],['f2','f3'],['f3','f4'],['f4','f5'],['f5','f6'],['f6','f7']]),

  revenuedesk: () => build('revenuedesk', 'RevenueDesk lead flow', 'RevenueDesk',
    'Shows where **leads stall** between first contact and a won or lost deal. Next action: fix the first step with a **missing owner or overdue follow-up**. Flags come from explicit rules only.',
    [
      ['r1', 'Source', 'Lead source', 'Observed', 'Agent', 'List every channel that sends leads'],
      ['r2', 'Step', 'Capture', 'Observed', 'Agent', 'Require name and one contact method'],
      ['r3', 'Step', 'De-duplicate', 'Unknown', 'Agent', 'Match on phone, then email'],
      ['r4', 'Step', 'Intent and fit score', 'Inference', 'Agent', 'Write the scoring rule in plain words'],
      ['r5', 'Step', 'Owner assigned', 'Unknown', 'Principal', 'Assign within 15 minutes'],
      ['r6', 'Step', 'Response SLA', 'Unknown', 'Owner', 'Flag any lead unanswered after the SLA'],
      ['r7', 'Step', 'Follow-up', 'Unknown', 'Owner', 'Log every call and message'],
      ['r8', 'Outcome', 'Won or lost', 'Unknown', 'Owner', 'Record the reason for every loss'],
      ['r9', 'Step', 'Recovery task', 'Unknown', 'Principal', 'Reopen lost leads with a clear reason'],
    ], 3,
    [['r1','r2'],['r2','r3'],['r3','r4'],['r4','r5'],['r5','r6'],['r6','r7'],['r7','r8'],['r8','r9']]),

  blank: () => build('blank', 'Untitled map', 'General',
    'A blank map. Add **cards**, link them, label the **evidence** on each, then export the brief. Next action: add the first card.',
    [], 3, []),
}
export const TEMPLATE_NAMES: Record<string, string> = {
  council: 'Council stage map', cargoiq: 'CargoIQ case map', flavourly: 'Flavourly journey',
  revenuedesk: 'RevenueDesk lead flow', blank: 'Blank map',
}
