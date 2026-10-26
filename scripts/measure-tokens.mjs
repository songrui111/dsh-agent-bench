/**
 * Measure the token cost this plugin adds to the model context.
 *
 * Two distinct costs:
 *   1. IDLE  - the tool catalog: 5 tool definitions + 1 command description are
 *              part of every request in any session where the plugin is loaded.
 *   2. RUN   - bench_run spawns a full agent run per case, plus one review call.
 *
 * This script measures (1) precisely by serialising what the model actually
 * sees, and describes (2) from the code's own limits.
 */
import { apply } from '../lib/index.js'

const tools = []
const commands = []
const ctx = {
  tools: { register: (t) => { tools.push(t); return () => {} } },
  commands: { register: (c) => { commands.push(c); return () => {} } },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  get: () => undefined,
}
await apply(ctx, {})

// Approximate what the model receives: name + description + parameter schema.
function serializeTool(t) {
  return JSON.stringify({
    name: t.name,
    description: t.description,
    parameters: t.parameters ?? {},
  })
}

let totalChars = 0
console.log('=== tool catalog (sent with every request) ===')
for (const t of tools) {
  const s = serializeTool(t)
  totalChars += s.length
  console.log(`${t.name.padEnd(16)} ${String(s.length).padStart(6)} chars  ~${Math.round(s.length / 4)} tokens`)
}

let cmdChars = 0
for (const c of commands) {
  const s = JSON.stringify({ name: c.name, description: c.description })
  cmdChars += s.length
  console.log(`/${c.name}`.padEnd(17) + `${String(s.length).padStart(6)} chars  ~${Math.round(s.length / 4)} tokens`)
}

const total = totalChars + cmdChars
console.log('---')
console.log(`tools+command total : ${total} chars  ~${Math.round(total / 4)} tokens (English ≈4 chars/token)`)

console.log('\n=== per-run cost (only when bench_run is called) ===')
console.log('each case  : 1 full agent run (system prompt + tool catalog + reasoning + edits)')
console.log('             realistic range 8k-40k input tokens, plus output tokens')
console.log('each review: 1 call, prompt capped ~14k chars of asserted file content')
console.log('             + up to 1200 output tokens (2400 on the retry attempt)')
console.log('core suite : 4 cases + 4 reviews per full run')
