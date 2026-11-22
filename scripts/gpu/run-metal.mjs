import { spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { trashPath } from '../electron-delivery.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const [mode, ...args] = process.argv.slice(2)
if (!['test', 'benchmark'].includes(mode) || (mode === 'test' && args.length) ||
    (mode === 'benchmark' && (args.length !== 2 || args[0] !== '--output' || !args[1]))) {
  throw new Error('Usage: node scripts/gpu/run-metal.mjs test|benchmark [--output DIRECTORY]')
}
let childProcess, interrupted
const handlers = Object.fromEntries(['SIGINT', 'SIGTERM'].map(signal => [signal, () => {
  interrupted = signal
  childProcess?.kill(signal)
}]))
for (const [signal, handler] of Object.entries(handlers)) process.on(signal, handler)

function run(argv, env) {
  return new Promise((resolve, reject) => {
    if (interrupted) return reject(new Error(`Metal command interrupted (${interrupted}).`))
    const child = spawn(process.execPath, argv, { cwd: root, env, stdio: 'inherit' })
    childProcess = child
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      childProcess = undefined
      code === 0 && !interrupted ? resolve() : reject(new Error(`Metal command failed (${interrupted ?? signal ?? code}).`))
    })
  })
}

const directory = await mkdtemp(join(tmpdir(), 'perpetual-swap-metal-'))
const env = { ...process.env, PERPETUAL_SWAP_METAL_PROVIDER_DIR: directory }
try {
  await run(['scripts/gpu/build-metal-provider.mjs', '--tests'], env)
  if (mode === 'test') {
    await run(['--test', 'tests/core/metal-provider.test.mjs'], { ...env, PERPETUAL_SWAP_METAL_NATIVE_TESTS: '1' })
    await run(['scripts/test-sandbox.mjs', 'gpu', '--metal', '--require-gpu-hardware-timing'], env)
  } else {
    await run(['scripts/metal-observer-overhead.mjs', ...args], env)
  }
} finally {
  await trashPath(directory)
  for (const [signal, handler] of Object.entries(handlers)) process.off(signal, handler)
}
