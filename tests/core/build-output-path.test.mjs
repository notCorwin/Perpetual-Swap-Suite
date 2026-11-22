import assert from 'node:assert/strict'
import { mkdtemp, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { assertOutsideBuildSync } from '../../scripts/build-output-path.mjs'
import { trashPath } from '../../scripts/electron-delivery.mjs'

test('build output protection rejects direct, existing, and dangling symlink aliases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perp-output-path-'))
  try {
    const build = join(root, '.build')
    await symlink(build, join(root, 'alias'))
    assert.throws(() => assertOutsideBuildSync(root, join(build, 'reports')), /outside .build/)
    assert.throws(() => assertOutsideBuildSync(root, join(root, 'alias', 'reports')), /outside .build/)
    await mkdir(build)
    assert.throws(() => assertOutsideBuildSync(root, join(root, 'alias', 'reports')), /outside .build/)
    assert.doesNotThrow(() => assertOutsideBuildSync(root, join(root, '.build-other', 'reports')))
  } finally { await trashPath(root) }
})
