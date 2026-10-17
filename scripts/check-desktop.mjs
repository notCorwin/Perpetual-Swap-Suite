#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const sourceExtensions = new Set(['.js', '.cjs', '.mjs', '.ts', '.cts', '.mts'])
const typescriptExtensions = new Set(['.ts', '.cts', '.mts'])

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    if (!entry.isFile() || /\.d\.(?:ts|cts|mts)$/.test(entry.name)) return []
    return sourceExtensions.has(extname(entry.name)) ? [path] : []
  }).sort()
}

// Parse with the runtime that executes these files. --check does not import or
// execute the source, so checking services never opens a database or a network
// connection. TypeScript declarations and type errors are checked by tsc -b.
export function checkDesktopFiles(root = projectRoot) {
  const files = ['electron', 'scripts'].flatMap(directory => sourceFiles(join(root, directory)))
  const errors = []
  for (const file of files) {
    try {
      const typescript = typescriptExtensions.has(extname(file))
      // Explicit stripping also works on runtimes where --check does not strip
      // an import-free .ts file. The stripped text is still only parsed.
      const input = typescript ? stripTypeScriptTypes(readFileSync(file, 'utf8')) : undefined
      const args = typescript ? ['--check', `--input-type=${extname(file) === '.cts' ? 'commonjs' : 'module'}`] : ['--check', file]
      const result = spawnSync(process.execPath, args, { cwd: root, input, encoding: 'utf8', timeout: 20_000 })
      if (result.status !== 0) errors.push({
        file: relative(root, file),
        message: result.error?.message || result.stderr.trim() || result.stdout.trim() || `Syntax check exited with ${result.status}.`,
      })
    } catch (error) {
      errors.push({ file: relative(root, file), message: error.stack || error.message })
    }
  }
  return { checkedFiles: files.map(file => relative(root, file)), errors }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = checkDesktopFiles()
    if (result.errors.length) {
      for (const error of result.errors) console.error(`${error.file}:\n${error.message}`)
      process.exitCode = 1
    } else console.log(`Desktop syntax: ${result.checkedFiles.length} main, preload, service, and script files passed.`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
