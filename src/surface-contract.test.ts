import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { checkSurfaceFiles, inspectSurfaceContract } from '../scripts/check-surfaces.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8')
const check = (source: string, file = 'src/components/ui/example.tsx') => inspectSurfaceContract(source, file, css)

test('all app surfaces obey the material contract, including CVA variants', () => {
  assert.deepEqual(checkSurfaceFiles(root), [])
})

test('new surfaces must declare an owner and use theme colors', () => {
  assert.match(check('<div className="bg-card" />').join('\n'), /data-surface/)
  assert.match(check('<div data-surface="opaque" className="bg-card" />').join('\n'), /Unknown/)
  assert.match(check('<div data-surface={active ? "panel" : "opaque"} className="bg-card" />').join('\n'), /Unknown/)
  assert.match(check('<div data-surface="panel" className="bg-white" />').join('\n'), /design token/)
  assert.match(check('<div data-surface="control" className="bg-background" />').join('\n'), /replace a component material/)
  assert.match(check('<div data-surface="control" className="bg-card" />').join('\n'), /surface layer/)
  assert.deepEqual(check('<div data-surface="panel" className="bg-card" />'), [])
})

test('CVA, conditional selectors and arbitrary colors cannot hide a material regression', () => {
  assert.match(check('const styles = cva("border", { variants: { kind: { normal: "bg-card", bad: "dark:bg-input/30" } } }); function Example() { return <div className={cn(styles())} /> }').join('\n'), /data-surface/)
  assert.match(check('<div data-surface="control" className="dark:bg-input/30" />').join('\n'), /Dark backgrounds/)
  assert.match(check('<div data-surface="control" className="hover:bg-[#ffffff]" />').join('\n'), /design token/)
  assert.match(check('<div className="text-violet-500" />').join('\n'), /design tokens/)
  assert.deepEqual(check('<div data-surface="inherited" className="has-[>[data-slot=field]]:hover:bg-state-accent" />'), [])
})

test('filters and inline material values cannot bypass the centralized material', () => {
  assert.match(check('<div data-surface="control" className="bg-control backdrop-blur-md" />').join('\n'), /shared material/)
  assert.match(check('<div data-surface="panel" style={{ backgroundColor: "#fff" }} />').join('\n'), /design token/)
  assert.match(check('<div data-surface="panel" style={{ color: "var(--missing)" }} />').join('\n'), /declared design token/)
  assert.match(check('<div style={{ backgroundColor: "var(--card)" }} />').join('\n'), /data-surface/)
  assert.match(check('<div data-surface="panel" style={{ backdropFilter: "var(--panel-filter)" }} />').join('\n'), /bypass/)
  assert.match(check('<div className="shadow-md" />').join('\n'), /shadows/)
  assert.deepEqual(check('<div className="shadow-floating" />'), [])
})

test('floating materials mount without an entry or exit animation', () => {
  assert.match(css, /\[data-surface="floating"\]\s*\{[^}]*animation:\s*none;/s)
})

test('floating materials use one dense desktop compositor path', () => {
  const webEntry = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')
  const desktopBridge = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8')
  const opacity = Number(css.match(/--floating-default-opacity:\s*([\d.]+)/)?.[1])
  assert.ok(opacity >= 0.9)
  assert.doesNotMatch(webEntry + desktopBridge, /floatingGlassSurfaces|installFloatingGlass/)
})

test('business code composes component states without replacing its material', () => {
  assert.match(check('import { Button } from "@/components/ui/button"; const x = <Button className="bg-card" />', 'src/Example.tsx').join('\n'), /Compose UI/)
  assert.match(check('import { Button } from "@/components/ui/button"; const x = <Button data-surface="inherited" />', 'src/Example.tsx').join('\n'), /Compose UI/)
  assert.deepEqual(check('import { Button } from "@/components/ui/button"; const x = <Button variant="outline" className="w-full" aria-expanded />', 'src/Example.tsx'), [])
})
