import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { installMainLoopWitness } from '../../scripts/main-loop-witness.mjs'

// Covers the test/process lifetime. Match raw epochs to a report's measured
// phase; warmup and post-timing validation are deliberately not acceptance data.
export async function startProcessWitness(electron, name, { capacity = 6_002 } = {}) {
  await electron.evaluate(installMainLoopWitness, { capacity })
  let stopped
  return () => stopped ??= (async () => {
    const evidence = await electron.evaluate(() => {
      const mainLoop = globalThis.__mainLoopWitness.stop()
      const require = process.getBuiltinModule('module').createRequire(`${process.cwd()}/package.json`)
      const { initializeOperationRecording } = require('./electron/services/operation-runtime.js')
      const recording = initializeOperationRecording()
      if (!recording) throw new Error('Process witnesses require protected operation recording.')
      const writers = [...recording.writers.values()].map(writer => {
        const health = writer.health()
        return { executionId: health.executionId, role: health.role, selfTiming: health.selfTiming }
      })
      return { mainLoop, writers }
    })
    const report = { schemaVersion: 1, name, scope: 'Entire test/process lifetime; correlate raw epoch timestamps with the measured phase.',
      generatedAt: new Date().toISOString(), ...evidence }
    const directory = resolve(process.env.PERPETUAL_SWAP_PROCESS_WITNESS_DIRECTORY ?? '.build/process-witness')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${name.replace(/[^a-z0-9]+/gi, '-')}.json`), `${JSON.stringify(report)}\n`)
    return report
  })()
}
