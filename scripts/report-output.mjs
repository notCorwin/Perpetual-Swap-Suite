import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertOutsideBuild } from './build-output-path.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

// Persistent diagnostics must have an explicit destination, either directly or
// through a sandbox with an explicitly selected report directory.
export async function reportOutput(explicit, relativeName, option) {
  const reportDirectory = process.env.PERPETUAL_SWAP_SANDBOX_REPORT_DIR
  if (!explicit && !reportDirectory) throw new Error(`Specify ${option} or run in a test sandbox with an explicit --output directory to retain diagnostic results.`)
  const output = explicit ? resolve(explicit) : resolve(join(reportDirectory, relativeName))
  await assertOutsideBuild(root, output, 'Diagnostic output')
  return output
}
