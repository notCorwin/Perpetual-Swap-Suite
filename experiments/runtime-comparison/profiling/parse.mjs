// macOS sample(1) emits an inclusive, per-thread call tree. Counts are thread
// observations, not CPU samples: a blocked thread appears at every interval.
export const categories = [
  'json_serialization', 'memory_copy', 'transport_ipc', 'layout_style', 'svg_paint',
  'js_execution', 'garbage_collection', 'idle_wait', 'other', 'unknown',
]

const rules = [
  ['idle_wait', /^(?:__psynch_(?:cvwait|mutexwait|rw_rdlock|rw_wrlock)|__ulock_wait(?:2)?|semaphore_(?:timed)?wait(?:_signal)?_trap|mach_msg(?:2)?_trap|mach_msg_overwrite_trap|kevent(?:64|_qos|_id)?|(?:__)?(?:pselect|select|poll|nanosleep|sigsuspend|sigwait|workq_kernreturn|wait4|waitid|waitpid|pause))\b/i],
  ['garbage_collection', /(?:garbage.?collect|\b(?:GC|GCSweep|GCMark|Scaveng(?:e|er)|MarkCompact|MinorGC|MajorGC)\b|Heap::Collect|Heap::Scavenge|Heap::PerformGarbage|Collector::)/i],
  ['json_serialization', /(?:\bJSON\b|JSON(?:Parse|Stringify|Serializer|Deserializer)|JSONString|Json(?:Reader|Writer|Parser|Serializer)|serialize|deserializ|structured.?clone|value.?serializer|value.?deserializer)/i],
  ['memory_copy', /(?:^|\b)(?:_?memcpy|_?memmove|_?bcopy|_?memset|copy(?:Bytes|Data|Memory|Buffer)|WTF::fastMemcpy)(?:\b|\()/i],
  ['transport_ipc', /(?:\bHTTP\b|https?[_:]|HTTP(?:Server|Connection|Parser|Response|Request)|WebSocket|EventSource|ServerSentEvent|\bSSE\b|socket|\b(?:sendmsg|recvmsg|sendto|recvfrom|connect|accept|bind|listen)\b|\bIPC\b|\bXPC\b|\bxpc_|mojo::|uv_(?:tcp|pipe|write|read)|NetworkProcess)/i],
  ['layout_style', /(?:\blayout\b|Layout(?:Object|Box|Block|Tree|State|Context|Rect)|Render(?:Block|Box|Tree|Layout)|recalc(?:ulate)?Style|style(?:Resolver|Recalc|Invalidation|Engine)|ComputedStyle|Style::)/i],
  ['svg_paint', /(?:\bSVG\b|SVG[A-Z_:]|\bpaint(?:ing|er)?\b|paint[A-Z_:]|Paint[A-Z_:]|raster(?:ize|ization)?|GraphicsContext|DisplayList|CoreGraphics|CGContext|drawPath)/i],
  ['js_execution', /(?:\bJavaScriptCore\b|\bJSC::|\bv8::|\bV8\b|\bBuiltins_|\b(?:JS|JIT)(?:Entry|Function|Code|Call|Execute|Execution|Interpreter|Compiler)|Interpreter(?:Entry|Frame)|Bytecode|LLInt|DFG::|FTL::|JavaScript)/i],
]
const unknownSymbol = symbol => !symbol || /^\?+$/u.test(symbol) || /^0x[0-9a-f]+$/i.test(symbol) || /^<unknown/u.test(symbol)

function parseFrame(text) {
  const match = /^(.*?)\s+\(in (.*?)\)(?:\s+\+\s+.*|\s+\[.*)?$/u.exec(text)
  const symbol = (match ? match[1] : text.replace(/\s+\[0x[\da-f, .]+\].*$/i, '')).trim()
  return { text, symbol, binary: match?.[2] ?? null }
}

function categoryFor(path) {
  const leaf = path.at(-1)
  // An anonymous JIT address beneath a JS trampoline does not prove what ran.
  if (!leaf || unknownSymbol(leaf.symbol)) return 'unknown'
  // A known blocking leaf takes precedence over the caller's activity.
  if (rules[0][1].test(leaf.symbol)) return 'idle_wait'
  // Attribute the nearest recognized operation, not every inclusive ancestor.
  // A generic V8/JSC frame can be below a GC or serialization operation;
  // prefer a specific operation anywhere in the path before the engine label.
  for (let i = path.length - 1; i >= 0; i--) {
    if (unknownSymbol(path[i].symbol)) continue
    for (const [name, regex] of rules.slice(1, -1)) if (regex.test(path[i].symbol)) return name
  }
  if (path.some(frame => !unknownSymbol(frame.symbol) && rules.at(-1)[1].test(frame.symbol))) return 'js_execution'
  return 'other'
}

/** Parse the call graph only. Raw sample text remains the authoritative evidence. */
export function parseSample(text, { maxRankedStacks = 50 } = {}) {
  if (typeof text !== 'string') throw new TypeError('Sample report must be a string.')
  if (!Number.isInteger(maxRankedStacks) || maxRankedStacks < 1 || maxRankedStacks > 200) throw new TypeError('maxRankedStacks must be between 1 and 200.')
  const lines = text.split(/\r?\n/u)
  const start = lines.findIndex(line => /^Call graph:\s*$/u.test(line))
  const threads = [], errors = []
  let thread, parents = [], inGraph = start >= 0
  if (!inGraph) errors.push('Call graph section was not found.')
  for (let i = start + 1; inGraph && i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    if (/^\S/u.test(line)) break
    const header = /^\s*(\d+)\s+(Thread_\S+.*)$/u.exec(line)
    if (header) {
      thread = { name: header[2], weight: Number(header[1]), children: [] }
      threads.push(thread); parents = []
      continue
    }
    const match = /^([ +!|:\t]*)(\d+)\s+(.+)$/u.exec(line)
    if (!match || !thread) {
      errors.push(`Unrecognized call graph line ${i + 1}; the current thread cannot be attributed.`)
      if (thread) thread.invalid = true
      continue
    }
    const column = match[1].length
    const node = { weight: Number(match[2]), ...parseFrame(match[3]), children: [] }
    while (parents.length && parents.at(-1).column >= column) parents.pop()
    if (parents.length >= 512) { errors.push(`Call graph exceeds the supported depth at line ${i + 1}.`); thread.invalid = true; inGraph = false; break }
    ;(parents.at(-1)?.node.children ?? thread.children).push(node)
    parents.push({ column, node })
  }
  const counts = Object.fromEntries(categories.map(category => [category, 0]))
  const ranked = new Map()
  let totalThreadObservations = 0, attributedObservations = 0, symbolizedLeafObservations = 0, unknownLeafObservations = 0, pathsWithUnknownFrame = 0
  let invalidThreadObservations = 0
  for (const item of threads) {
    totalThreadObservations += item.weight
    let valid = !item.invalid && Number.isSafeInteger(item.weight) && item.weight > 0
    const verify = node => {
      if (!Number.isSafeInteger(node.weight) || node.weight < 1 || node.children.reduce((sum, child) => sum + child.weight, 0) > node.weight) valid = false
      for (const child of node.children) verify(child)
    }
    verify(item)
    if (!valid) { errors.push(`Invalid inclusive weights in ${item.name}; this thread was excluded.`); invalidThreadObservations += item.weight; continue }
    const visit = (node, path) => {
      const next = node === item ? path : [...path, node]
      const residual = node.weight - node.children.reduce((sum, child) => sum + child.weight, 0)
      if (residual > 0) {
        const category = categoryFor(next)
        counts[category] += residual; attributedObservations += residual
        const leaf = next.at(-1)
        if (!leaf || unknownSymbol(leaf.symbol)) unknownLeafObservations += residual
        else symbolizedLeafObservations += residual
        if (next.some(frame => unknownSymbol(frame.symbol))) pathsWithUnknownFrame += residual
        if (category !== 'idle_wait') {
          const frames = next.map(({ symbol, binary }) => ({ symbol, binary }))
          const key = JSON.stringify([category, frames])
          const existing = ranked.get(key)
          if (existing) existing.observations += residual
          else ranked.set(key, { category, observations: residual, frames })
        }
      }
      for (const child of node.children) visit(child, next)
    }
    visit(item, [])
  }
  // The complete inclusive tree is retained. The ranking limits only the
  // presentation and keeps the most specific frames for very deep stacks.
  const allRanked = [...ranked.values()].sort((a, b) => b.observations - a.observations)
  const rankedStacks = allRanked.slice(0, maxRankedStacks).map(({ frames, ...stack }) => ({ ...stack,
    omittedAncestors: Math.max(0, frames.length - 40), frames: frames.slice(-40) }))
  return {
    format: 'macOS sample call graph', threads, categories: counts, rankedStacks,
    coverage: { totalThreadObservations, attributedObservations, invalidThreadObservations, symbolizedLeafObservations,
      unknownLeafObservations, pathsWithUnknownFrame, rankedStacksShown: rankedStacks.length, rankedStacksTotal: allRanked.length,
      callGraphFound: start >= 0, errors },
    cpu: { runningStateAvailable: false, normalizedCategories: null,
      reason: 'sample(1) aggregates wall-clock thread observations and does not identify which individual observations were running; wait detection alone cannot establish CPU time.' },
    limitation: 'Categories are heuristic and mutually exclusive per terminal observation; unknown symbols remain unknown. Counts include waits and must not be interpreted as CPU percentages.',
  }
}
