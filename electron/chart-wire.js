// The chart boundary carries plain, acyclic data records and dense arrays.
// JSON supplies the fast bulk representation; the sidecar restores values JSON
// cannot represent. Object properties whose value is undefined retain their
// presence, although their insertion order may change after restoration. Chart
// consumers address these optional fields by name, never by property order.
const VERSION = 1
const UNDEFINED = 0, NAN = 1, POSITIVE_INFINITY = 2, NEGATIVE_INFINITY = 3, NEGATIVE_ZERO = 4

export function encodeChartWire(value) {
  const exceptions = [], path = [], ancestors = new Set()
  const visit = item => {
    let special
    if (item === undefined) special = UNDEFINED
    else if (typeof item === 'number') {
      if (Number.isNaN(item)) special = NAN
      else if (item === Infinity) special = POSITIVE_INFINITY
      else if (item === -Infinity) special = NEGATIVE_INFINITY
      else if (Object.is(item, -0)) special = NEGATIVE_ZERO
    } else if (item !== null && typeof item === 'object') {
      const array = Array.isArray(item)
      if (Object.getPrototypeOf(item) !== (array ? Array.prototype : Object.prototype)) throw new TypeError('Chart wire requires plain data objects.')
      if (ancestors.has(item)) throw new TypeError('Chart wire cannot encode cycles.')
      ancestors.add(item)
      const keys = Reflect.ownKeys(item)
      if (array && keys.length !== item.length + 1) throw new TypeError('Chart wire requires dense arrays without extra fields.')
      for (const key of keys) {
        if (array && key === 'length') continue
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        if (typeof key !== 'string' || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')
          || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= item.length)) {
          throw new TypeError('Chart wire requires enumerable plain data fields.')
        }
        path.push(key)
        visit(descriptor.value)
        path.pop()
      }
      ancestors.delete(item)
    } else if (!['string', 'boolean'].includes(typeof item) && item !== null) {
      throw new TypeError('Chart wire contains an unsupported value.')
    }
    if (special !== undefined) exceptions.push([path.slice(), special])
  }
  visit(value)
  return JSON.stringify([VERSION, value, exceptions])
}

export function decodeChartWire(wire) {
  if (typeof wire !== 'string') throw new TypeError('Invalid chart wire: expected a string.')
  const envelope = JSON.parse(wire)
  if (!Array.isArray(envelope) || envelope.length !== 3 || envelope[0] !== VERSION || !Array.isArray(envelope[2])) {
    throw new TypeError('Invalid chart wire envelope.')
  }
  let data = envelope[1], replacedRoot = false
  for (const entry of envelope[2]) {
    if (!Array.isArray(entry) || entry.length !== 2 || !Array.isArray(entry[0])
      || !entry[0].every(key => typeof key === 'string') || !Number.isInteger(entry[1]) || entry[1] < UNDEFINED || entry[1] > NEGATIVE_ZERO) {
      throw new TypeError('Invalid chart wire exception.')
    }
    const [path, code] = entry
    const restored = code === UNDEFINED ? undefined : code === NAN ? NaN : code === POSITIVE_INFINITY ? Infinity : code === NEGATIVE_INFINITY ? -Infinity : -0
    if (!path.length) {
      if (replacedRoot || !(code === NEGATIVE_ZERO ? Object.is(data, 0) : data === null)) throw new TypeError('Invalid chart wire root exception.')
      data = restored; replacedRoot = true
      continue
    }
    let parent = data
    for (const key of path.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new TypeError('Invalid chart wire exception path.')
      parent = parent[key]
    }
    if (parent === null || typeof parent !== 'object') throw new TypeError('Invalid chart wire exception parent.')
    const key = path.at(-1), array = Array.isArray(parent), present = Object.hasOwn(parent, key)
    if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= parent.length)) throw new TypeError('Invalid chart wire array index.')
    if (code === UNDEFINED && !array ? present : !present || !(code === NEGATIVE_ZERO ? Object.is(parent[key], 0) : parent[key] === null)) {
      throw new TypeError('Invalid chart wire exception value.')
    }
    // Define rather than assign, so even a field named __proto__ remains data.
    Object.defineProperty(parent, key, { value: restored, enumerable: true, writable: true, configurable: true })
  }
  return data
}
