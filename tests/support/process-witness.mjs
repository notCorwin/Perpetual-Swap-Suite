import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installMainLoopWitness, startNodeDriverLoopWitness } from '../../scripts/main-loop-witness.mjs'

// Covers the test/process lifetime. Match raw epochs to a report's measured
// phase; warmup and post-timing validation are deliberately not acceptance data.
export async function startProcessWitness(electron, name, { capacity = 6_002, directory, driverRuntime } = {}) {
  const ownerId = randomUUID(), errors = [], evidence = {}
  const driver = startNodeDriverLoopWitness({ capacity, ownerId, runtime: driverRuntime })
  const failed = (stage, error) => errors.push({ stage, error })
  const collect = async ({ starting = false } = {}) => {
    // Finalize the separately owned local timer before any fallible Electron RPC.
    try { evidence.nodeDriverLoop = driver.stop() } catch (error) { failed('stop-node-driver', error) }
    try {
      Object.assign(evidence, await electron.evaluate((_, { ownerId, starting }) => {
        const witness = globalThis.__mainLoopWitness
        if (!witness || witness.ownerId !== ownerId) {
          if (starting) return {}
          throw new Error('The owned Electron main-loop witness is missing.')
        }
        const mainLoop = witness.stop()
        try {
          const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
          const { initializeOperationRecording } = require('./electron/services/operation-runtime.js')
          const recording = initializeOperationRecording()
          if (!recording) throw new Error('Process witnesses require protected operation recording.')
          const writers = [...recording.writers.values()].map(writer => {
            const health = writer.health()
            return { executionId: health.executionId, role: health.role, selfTiming: health.selfTiming }
          })
          return { mainLoop, writers }
        } catch (error) { return { mainLoop, writerError: error.stack ?? error.message ?? String(error) } }
      }, { ownerId, starting }))
      if (evidence.writerError) failed('writers', new Error(evidence.writerError))
    } catch (error) { failed('collect-electron', error) }
    const report = { schemaVersion: 2, name, ownerId,
      scope: 'Entire test/process lifetime; correlate raw epoch timestamps with the measured phase. Node driver and Electron main timers are independently owned and finalized.',
      generatedAt: new Date().toISOString(), ...evidence,
      complete: !errors.length && evidence.nodeDriverLoop?.complete === true && evidence.mainLoop?.complete === true,
      collectionErrors: errors.map(({ stage, error }) => ({ stage, message: error.stack ?? error.message ?? String(error) })) }
    const outputDirectory = resolve(directory ?? process.env.PERPETUAL_SWAP_PROCESS_WITNESS_DIRECTORY ?? '.build/process-witness')
    report.artifact = join(outputDirectory, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`)
    try {
      await mkdir(outputDirectory, { recursive: true })
      await writeFile(report.artifact, `${JSON.stringify(report)}\n`)
    } catch (error) {
      failed('write-artifact', error)
      report.complete = false
      report.collectionErrors.push({ stage: 'write-artifact', message: error.stack ?? error.message ?? String(error) })
    }
    if (errors.length) {
      const error = new AggregateError(errors.map(({ error }) => error), errors.map(({ stage, error }) => `${stage}: ${error.message ?? error}`).join('\n'), { cause: errors[0].error })
      error.processWitness = report
      throw error
    }
    return report
  }
  try { await electron.evaluate(installMainLoopWitness, { capacity, ownerId }) }
  catch (error) {
    failed('start-electron', error)
    return await collect({ starting: true })
  }
  let stopped
  return () => stopped ??= collect()
}
