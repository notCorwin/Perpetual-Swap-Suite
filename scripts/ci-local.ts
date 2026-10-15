import { spawn } from 'node:child_process'
import { mkdirSync, openSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = resolve(import.meta.dirname, '..')
const logs = join(root, '.build', 'ci')
mkdirSync(logs, { recursive: true })

async function run(name: string, command: string, args: string[]) {
  const started = performance.now()
  const log = openSync(join(logs, `${name}.log`), 'w')
  try {
    await new Promise<void>((accept, reject) => {
      const child = spawn(command, args, { cwd: root, stdio: ['ignore', log, log] })
      child.once('error', reject)
      child.once('exit', code => code === 0 ? accept() : reject(new Error(`${name} failed; see .build/ci/${name}.log`)))
    })
    console.log(`✓ ${name} ${((performance.now() - started) / 1000).toFixed(2)}s`)
  } finally {
    closeSync(log)
  }
}

try {
  await run('dependencies', 'npm', ['ci'])
  await Promise.all([
    run('web-build', 'npm', ['run', 'build']),
    run('web-lint', 'npm', ['run', 'lint']),
    run('web-tests', 'npm', ['test']),
    run('native-tests', 'swift', ['test']),
  ])
  await run('app-package', 'npm', ['run', 'app'])
  console.log('Local CI passed.')
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
}
