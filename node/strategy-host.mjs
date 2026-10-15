import readline from 'node:readline'
import { pathToFileURL } from 'node:url'

const strategyPath = process.argv[2]
if (!strategyPath) throw new Error('A strategy file path is required.')

let moduleInstance
let settings
let commands = []
let history = []
const queries = new Map()
let querySequence = 0

const send = value => process.stdout.write(`${JSON.stringify(value)}\n`)
console.log = (...values) => send({ type: 'log', message: values.map(String).join(' ') })
console.info = console.log
console.warn = console.log
console.error = console.log

function command(action, id, values = {}) {
  commands.push({ action, id, ...values })
}

globalThis.strategy = Object.freeze({
  long: 'long', short: 'short',
  entry(id, direction, options = {}) { command('entry', id, { direction, ...options }) },
  order(id, direction, options = {}) { command('order', id, { direction, ...options }) },
  exit(id, options = {}) { command('exit', id, { reduceOnly: true, ...options }) },
  close(id = 'close') { command('close', id, { reduceOnly: true }) },
  cancel(id) { command('cancel', id) },
  cancelAll() { command('cancelAll') },
})

globalThis.exchange = Object.freeze({
  placeOrder(order) { command('order', order.id, order) },
  amendOrder(id, changes) { command('amend', id, changes) },
  cancelOrder(id) { command('cancel', id) },
  cancelAllOrders() { command('cancelAll') },
})

globalThis.suite = Object.freeze({
  query(sql) {
    const requestID = `query-${++querySequence}`
    send({ type: 'query', requestID, sql })
    return new Promise((resolve, reject) => queries.set(requestID, { resolve, reject }))
  },
})

function ema(period, offset = 0) {
  const end = history.length - offset
  if (end < period || period <= 0) return null
  const alpha = 2 / (period + 1)
  let value = history[0].close
  for (let index = 1; index < end; index++) value = history[index].close * alpha + value * (1 - alpha)
  return value
}

function rsi(period = 14, offset = 0) {
  const end = history.length - offset
  if (end <= period) return null
  let gains = 0, losses = 0
  for (let index = end - period; index < end; index++) {
    const change = history[index].close - history[index - 1].close
    gains += Math.max(change, 0)
    losses += Math.max(-change, 0)
  }
  if (losses === 0) return 100
  return 100 - 100 / (1 + gains / losses)
}

async function handle(message) {
  if (message.type === 'queryResult') {
    const pending = queries.get(message.requestID)
    if (!pending) return
    queries.delete(message.requestID)
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.rows ?? [])
    return
  }
  if (message.type === 'stop') process.exit(0)
  try {
    if (message.type === 'init') {
      settings = message.settings
      moduleInstance = await import(`${pathToFileURL(strategyPath).href}?v=${Date.now()}`)
      if (typeof moduleInstance.onStart === 'function') await moduleInstance.onStart({ settings, suite })
      send({ type: 'ready', requestID: message.requestID, commands: [] })
      return
    }
    if (message.type === 'event') {
      const event = message.event
      if (event.bar.confirmed) {
        const last = history.at(-1)
        if (last?.timestamp === event.bar.timestamp) history[history.length - 1] = event.bar
        else history.push(event.bar)
      }
      commands = []
      const context = Object.freeze({
        ...event, history, settings,
        strategy, exchange, suite,
        indicators: Object.freeze({ ema, rsi }),
      })
      const returned = typeof moduleInstance.onTick === 'function' ? await moduleInstance.onTick(context) : undefined
      if (Array.isArray(returned)) commands.push(...returned)
      send({ type: 'result', requestID: message.requestID, commands })
    }
  } catch (error) {
    send({ type: 'error', requestID: message.requestID, error: error?.stack || String(error) })
  }
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
let queue = Promise.resolve()
reader.on('line', line => {
  let message
  try { message = JSON.parse(line) } catch (error) { send({ type: 'error', error: String(error) }); return }
  if (message.type === 'queryResult') void handle(message)
  else queue = queue.then(() => handle(message))
})
