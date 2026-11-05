import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, copyFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
const execute = promisify(execFile), root = fileURLToPath(new URL('../..', import.meta.url))
const result = await execute('sh', ['experiments/runtime-comparison/tauri/build.sh'], { cwd: root, maxBuffer: 4 * 1024 * 1024 })
process.stdout.write(result.stdout); process.stderr.write(result.stderr)
const binary = join(root, 'artifacts/runtime-comparison/tauri-target/release/radar-tauri-compare')
const app = join(root, 'artifacts/runtime-comparison/Radar Tauri Comparison.app'), contents = join(app, 'Contents')
const plist = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>radar-tauri-compare</string><key>CFBundleIdentifier</key><string>com.perpetualswapsuite.runtimecomparison.tauri.background</string><key>CFBundleName</key><string>Radar Tauri Comparison</string><key>CFBundlePackageType</key><string>APPL</string><key>LSBackgroundOnly</key><true/><key>LSUIElement</key><false/><key>NSHighResolutionCapable</key><true/></dict></plist>'
const signature = createHash('sha256').update(await readFile(binary)).update(plist).digest('hex')
const stamp = join(root, 'artifacts/runtime-comparison/tauri-bundle.sha256')
const executable = join(contents, 'MacOS/radar-tauri-compare')
if (await readFile(stamp, 'utf8').catch(() => '') !== signature) {
  await mkdir(join(contents, 'MacOS'), { recursive: true })
  await copyFile(binary, executable, constants.COPYFILE_FICLONE)
  await writeFile(join(contents, 'Info.plist'), plist)
  await execute('codesign', ['--force', '--deep', '--sign', '-', app])
  await writeFile(stamp, signature)
}
await execute('codesign', ['--verify', '--deep', '--strict', app])
console.log(JSON.stringify({ executable, signature }))
