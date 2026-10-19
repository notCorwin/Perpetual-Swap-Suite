import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
const execute = promisify(execFile), source = name => fileURLToPath(new URL(name, import.meta.url))
const directory = fileURLToPath(new URL('../../.build/gpu-provider/', import.meta.url)), output = name => join(directory, name)
if (process.platform !== 'darwin') throw new Error('Optional Metal diagnostics require macOS.')
if (process.argv.slice(2).some(value => value !== '--tests')) throw new Error('Usage: node scripts/gpu/build-metal-provider.mjs [--tests]')
await mkdir(directory, { recursive: true, mode: 0o700 })
await execute('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-dynamiclib', '-framework', 'Foundation', '-framework', 'Metal', source('metal-provider.m'), '-o', output('metal-provider.dylib')])
await execute('xcrun', ['clang', '-Wall', '-Wextra', '-Werror', source('metal-clock.c'), '-o', output('metal-clock')])
if (process.argv.includes('--tests')) await execute('xcrun', ['clang', '-fobjc-arc', '-Wall', '-Wextra', '-Werror', '-framework', 'Foundation', '-framework', 'Metal', source('metal-provider-proof.m'), '-o', output('metal-provider-proof')])
console.log(JSON.stringify({ provider: output('metal-provider.dylib'), clock: output('metal-clock'), scope: 'explicit own-subprocess diagnostics only' }))
