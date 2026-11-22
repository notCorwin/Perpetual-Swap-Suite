import { lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

// Resolve symlinks even when their target (or later path components) does not
// yet exist. Build output can be recreated after validation, so aliases to a
// currently absent .build directory must not bypass this check.
function canonical(path, depth = 0) {
  if (depth > 40) throw new Error('Too many symbolic links in output path.')
  let current = resolve(path)
  const suffix = []
  for (;;) {
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) return canonical(resolve(dirname(current), readlinkSync(current), ...suffix), depth + 1)
      return resolve(realpathSync(current), ...suffix)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(current)
      if (parent === current) throw error
      suffix.unshift(basename(current)); current = parent
    }
  }
}

function inside(base, path) {
  const child = relative(base, path)
  return child === '' || child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}

export function assertOutsideBuildSync(root, path, description = 'Output') {
  const base = resolve(root, '.build'), target = resolve(path)
  if (inside(base, target) || inside(canonical(base), canonical(target))) {
    throw new Error(`${description} must be outside .build, which is cleaned during builds.`)
  }
}

export async function assertOutsideBuild(root, path, description = 'Output') {
  assertOutsideBuildSync(root, path, description)
}
