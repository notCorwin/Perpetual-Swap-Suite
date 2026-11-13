#!/usr/bin/env node
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startSampling } from '../experiments/runtime-comparison/measurement/index.mjs'
import { summarizeResources } from '../experiments/runtime-comparison/analyze.mjs'

if (process.env.PERPETUAL_SWAP_SANDBOX !== '1' || process.env.PERPETUAL_SWAP_ALLOW_NETWORK !== '0') throw new Error('Run in the network-disabled test sandbox.')
const output = resolve(process.argv[2] ?? '.build/market-branch-resources.json')
const cycles = process.argv[3] ?? '1000'
const child = fork(fileURLToPath(new URL('./market-branch-replay.mjs', import.meta.url)), [output, cycles], {
  env: { ...process.env, PERPETUAL_SWAP_REPLAY_CONTROLLER: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
})
let sampler, capture, failure, exitResult
const messages = [], waiters = []
const exited = new Promise(resolveExit => {
  const finish = result => {
    if (exitResult) return
    exitResult = result
    for (const waiter of waiters.splice(0)) waiter.reject(new Error(`Replay child exited before its expected message: ${result.code ?? result.signal ?? result.error}`))
    resolveExit(result)
  }
  child.once('error', error => finish({ error: error.message }))
  child.once('exit', (code, signal) => finish({ code, signal }))
})
child.on('message', message => { const waiter = waiters.shift(); if (waiter) waiter.resolve(message); else messages.push(message) })
const nextMessage = expected => new Promise((resolveMessage, reject) => {
  if (exitResult) return reject(new Error(`Replay child exited before ${expected}.`))
  const waiter = { resolve: message => { clearTimeout(timer); message === expected ? resolveMessage() : reject(new Error(`Unexpected replay message: ${message}`)) },
    reject: error => { clearTimeout(timer); reject(error) } }
  const timer = setTimeout(() => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); reject(new Error(`Timed out waiting for replay ${expected}.`)) }, 30_000)
  if (messages.length) waiter.resolve(messages.shift()); else waiters.push(waiter)
})
const send = message => new Promise((resolveSend, reject) => {
  if (!child.connected) return reject(new Error(`Replay child disconnected before ${message}.`))
  child.send(message, error => error ? reject(error) : resolveSend())
})
try {
  await nextMessage('ready')
  sampler = await startSampling({ rootPids: [child.pid], intervalMS: 1000, includeWebKit: false,
    onSample(sample) { assert.equal(sample.frontmostIsRuntime, false, 'Replay process must not be frontmost.') } })
  await sampler.sampleBoundary('start')
  await send('run')
  await nextMessage('done')
  await sampler.sampleBoundary('end')
  capture = await sampler.stop(); sampler = undefined
  const summary = summarizeResources(capture).combined
  assert.equal(summary.coverage.boundaryStatus, 'explicit')
  assert.equal(summary.coverage.cpu.complete, true)
  assert.equal(summary.coverage.cpuEnergy.complete, true)
  await send('close')
  let closeTimer
  const result = await Promise.race([exited, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('Replay child did not exit after close.')), 5_000) })]).finally(() => clearTimeout(closeTimer))
  assert.equal(result.code, 0, `Replay child did not exit successfully: ${JSON.stringify(result)}`)
  const report = JSON.parse(await readFile(output, 'utf8'))
  report.resources = { measurement: 'Node MarketService process tree between explicit samples surrounding all phases and background drain. Sampler is outside the target process tree. CPU energy excludes GPU and display.', rawSamples: capture.samples, skippedSamples: capture.skippedSamples, summary }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ output, coverage: summary.coverage }))
} catch (error) {
  failure = error
} finally {
  const cleanupErrors = []
  if (sampler) try { capture = await sampler.stop() } catch (error) { cleanupErrors.push(`Sampler cleanup: ${error.message}`) }
  if (!exitResult) {
    child.kill('SIGTERM')
    await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000).unref())])
    if (!exitResult) {
      child.kill('SIGKILL')
      await Promise.race([exited, new Promise(resolveWait => setTimeout(resolveWait, 2_000).unref())])
    }
    if (!exitResult) { cleanupErrors.push('Replay child did not exit after SIGKILL.'); child.disconnect?.() }
  }
  if (failure || cleanupErrors.length) {
    const report = { schemaVersion: 1, mode: 'isolated-market-service-branch-replay', outcome: 'failed', partial: true,
      failure: failure?.message ?? cleanupErrors[0], cleanupErrors, childExit: exitResult,
      ...(capture ? { resources: { rawSamples: capture.samples, skippedSamples: capture.skippedSamples } } : {}) }
    try { await mkdir(dirname(output), { recursive: true }); await writeFile(output, `${JSON.stringify(report, null, 2)}\n`) }
    catch (error) { console.error(`Could not write failure report: ${error.message}`) }
    console.error(failure?.stack ?? report.failure)
    process.exitCode = 1
  }
}
