export function wrapAcceptedCallback(options, name, observe, restorers) {
  if (!options || typeof options[name] !== 'function') {
    throw new Error(`Application realtime callback ${name} is unavailable.`)
  }
  const original = options[name]
  const accepted = (args, value) => {
    observe(args)
    return value
  }
  const wrapped = function (...args) {
    const result = original.apply(this, args)
    const then = result !== null && (typeof result === 'object' || typeof result === 'function') ? result.then : null
    if (typeof then === 'function') return then.call(result, value => accepted(args, value))
    return accepted(args, result)
  }
  options[name] = wrapped
  restorers.push(() => { if (options[name] === wrapped) options[name] = original })
  return wrapped
}
