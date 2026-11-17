import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { fileURLToPath } from 'node:url'
import { checkSurfaceFiles, inspectSurfaceContract } from '../scripts/check-surfaces.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const tokens = `:root { --space-2: 6px; --background: white; --card: white; --input: gray; --foreground: black; --border: gray; --primary: blue; --secondary: gray; }
@theme inline { --color-background: var(--background); --color-card: var(--card); --color-input: var(--input); --color-foreground: var(--foreground); --color-border: var(--border); --color-primary: var(--primary); }`
const check = (source: string) => inspectSurfaceContract(source, 'src/components/ui/example.tsx', tokens)

test('renderer components use semantic design tokens and Base UI primitives', () => {
  assert.deepEqual(checkSurfaceFiles(root), [])
})

test('default shadcn token classes support opacity and theme variants', () => {
  assert.deepEqual(check('<div className="border-border bg-card text-foreground dark:bg-input/30 shadow-sm" />'), [])
  assert.deepEqual(check('<div className="hover:bg-primary/90 bg-transparent" />'), [])
  assert.deepEqual(check('<div style={{ backgroundColor: "var(--card)", color: "var(--foreground)" }} />'), [])
  assert.deepEqual(check('<div className="bg-(--card)" />'), [])
  assert.deepEqual(check('<div className="bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] bg-[oklch(from_var(--primary)_0.93_calc(c*0.4)_h)]" />'), [])
  assert.match(check('<div className="bg-[color-mix(in_oklch,var(--missing),var(--foreground)_5%)]" />').join('\n'), /design token/)
  assert.match(check('<div className="bg-[color-mix(in_oklch,var(--card),white_5%)]" />').join('\n'), /design token/)
})

test('CVA and conditional classes cannot hide hard-coded palette colors', () => {
  assert.match(check('const styles = cva("border", { variants: { kind: { normal: "bg-card", bad: "bg-white" } } }); function Example() { return <div className={styles()} /> }').join('\n'), /design token/)
  assert.match(check('<div className={active ? "bg-card" : "hover:bg-[#ffffff]"} />').join('\n'), /design token/)
  assert.match(check('<div className="text-violet-500" />').join('\n'), /semantic design tokens/)
  assert.match(check('<div style={{ color: "var(--missing)" }} />').join('\n'), /declared design token/)
  assert.match(check('<div style={{ backgroundColor: "#fff" }} />').join('\n'), /declared design token/)
})

test('Radix and glass effects cannot recreate an alternative component system', () => {
  assert.match(check('import { Slot } from "radix-ui"').join('\n'), /Base UI/)
  assert.match(check('import * as Dialog from "@radix-ui/react-dialog"').join('\n'), /Base UI/)
  assert.match(check('<div className="bg-card backdrop-blur-md" />').join('\n'), /backdrop filters/)
  assert.match(check('<div style={{ backdropFilter: "var(--card)" }} />').join('\n'), /Backdrop filters/)
  assert.deepEqual(check('import { Button } from "@base-ui/react/button"; const x = <Button className="bg-primary" />'), [])
})


test('spacing uses shared steps and belongs to layout containers', () => {
  assert.deepEqual(check('<div className="flex gap-3 px-4 mx-auto" />'), [])
  assert.deepEqual(check('<div className="gap-[var(--space-2)]" style={{ padding: "var(--space-2)", margin: 0 }} />'), [])
  for (const source of [
    '<div className="gap-[13px]" />',
    '<div className="gap-[var(--space-missing)]" />',
    '<div className="mt-2" />',
    '<div className="hover:-ml-1" />',
    '<div className="flex space-y-2" />',
    '<div style={{ gap: 13 }} />',
    'const styles = cva("flex", { variants: { size: { default: "gap-[13px]" } } }); const x = <div className={styles()} />',
  ]) assert.match(check(source).join('\n'), /spacing|Spacing/)
})
