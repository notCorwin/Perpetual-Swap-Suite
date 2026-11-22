import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let temporary
export function testArtifactDirectory() {
  const configured = process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR || process.env.PERPETUAL_SWAP_SANDBOX_WORK_DIR
  if (configured) return join(configured, 'process-witness')
  if (!temporary) {
    temporary = mkdtempSync(join(tmpdir(), 'perp-test-artifacts-'))
    process.once('exit', () => {
      const result = spawnSync('trash', ['-s', temporary], { stdio: 'inherit' })
      if (result.error || result.status !== 0) {
        console.error(`Could not move temporary test artifacts to Trash: ${temporary}`)
        process.exitCode = 1
      }
    })
  }
  return temporary
}
