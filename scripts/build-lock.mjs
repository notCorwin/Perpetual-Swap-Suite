import { createHash } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawnSync } from 'node:child_process'
import { mkdir, open, realpath } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'

const lockContext = new AsyncLocalStorage()

export async function buildLockPath(root) {
  const resolved = await realpath(root)
  const id = createHash('sha256').update(resolved).digest('hex')
  // Sandbox tasks intentionally set their own TMPDIR. A per-user location
  // derived from the OS account, not environment, gives them the same lock.
  const home = userInfo().homedir
  const cache = process.platform === 'darwin' ? join(home, 'Library', 'Caches') : join(home, '.cache')
  const directory = join(cache, 'perpetual-swap-suite', 'build-locks')
  await mkdir(directory, { recursive: true, mode: 0o700 })
  return join(directory, `${id}.lock`)
}

// The kernel owns the lock, so interrupted runs cannot leave a stale lock.
// Keep the lock file itself; removing it permits two different inodes to lock.
export async function withBuildLock(root, operation) {
  const handle = await open(await buildLockPath(root), 'a+', 0o600)
  try {
    const command = process.platform === 'darwin' ? '/usr/bin/lockf' : 'flock'
    const args = process.platform === 'darwin' ? ['-t', '0', '3'] : ['-n', '3']
    const acquired = spawnSync(command, args, { stdio: ['ignore', 'ignore', 'pipe', handle.fd], encoding: 'utf8' })
    if (acquired.error) throw new Error(`Unable to acquire the build lock: ${acquired.error.message}`)
    if (acquired.status !== 0) throw new Error('Another build or packaging operation is running. Wait for it to finish before building again.')
    return await lockContext.run(handle.fd, operation)
  } finally {
    await handle.close()
  }
}

export function buildChildStdio() {
  const descriptor = lockContext.getStore()
  return descriptor === undefined ? 'inherit' : ['inherit', 'inherit', 'inherit', descriptor]
}
