import { parse } from '@babel/parser'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

type SyntaxNode = { type: string; start?: number; [key: string]: unknown }
const surfaceKinds = new Set(['control', 'panel', 'floating', 'inherited'])
const surfacePaint: Record<string, Set<string>> = {
  control: new Set(['control', 'control-hover', 'secondary', 'muted', 'accent', 'selection', 'primary-surface', 'primary-surface-hover', 'destructive-surface', 'destructive-hover', 'positive-surface', 'chart-annotation']),
  panel: new Set(['card', 'sidebar', 'chart-surface']),
  floating: new Set(['popover']),
  inherited: new Set(['table-header', 'border', 'primary', 'foreground', 'overlay', 'chart-capture-flash']),
}
const isNode = (value: unknown): value is SyntaxNode => Boolean(value && typeof value === 'object' && 'type' in value && typeof value.type === 'string')
function walk(value: unknown, visit: (node: SyntaxNode) => void) {
  if (Array.isArray(value)) { for (const child of value) walk(child, visit); return }
  if (!isNode(value)) return
  visit(value)
  for (const child of Object.values(value)) walk(child, visit)
}

// Resolve CVA/const classes as well as inline cn() branches. This is an AST
// check: Tailwind selectors containing > must not break JSX tag detection.
export function inspectSurfaceContract(source: string, file: string, css: string): string[] {
  const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  const variables = new Map<string, unknown>(), uiComponents = new Set<string>()
  const tokens = new Set(Array.from(css.matchAll(/--([a-z][\w-]*)\s*:/g), match => match[1]))
  const colors = new Set(Array.from(css.matchAll(/--color-([\w-]*)\s*:/g), match => match[1]))
  const shadows = new Set(Array.from(css.matchAll(/--shadow-([\w-]*)\s*:/g), match => match[1]))
  const errors = new Set<string>()
  const report = (node: SyntaxNode, reason: string) => errors.add(`${file}:${source.slice(0, node.start ?? 0).split('\n').length}: ${reason}`)
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && isNode(node.id) && typeof node.id.name === 'string') variables.set(node.id.name, node.init)
    if (node.type === 'ImportDeclaration' && isNode(node.source) && String(node.source.value).includes('/components/ui/')) {
      for (const specifier of node.specifiers as SyntaxNode[]) if (isNode(specifier.local) && typeof specifier.local.name === 'string') uiComponents.add(specifier.local.name)
    }
  })
  function strings(value: unknown, seen = new Set<string>()): string[] {
    if (Array.isArray(value)) return value.flatMap(child => strings(child, seen))
    if (!isNode(value)) return []
    if (value.type === 'ConditionalExpression') return [...strings(value.consequent, seen), ...strings(value.alternate, seen)]
    if (value.type === 'StringLiteral') return [String(value.value)]
    if (value.type === 'TemplateElement' && value.value && typeof value.value === 'object' && 'raw' in value.value) return [String(value.value.raw)]
    if (value.type === 'Identifier' && typeof value.name === 'string' && !seen.has(value.name)) {
      return strings(variables.get(value.name), new Set([...seen, value.name]))
    }
    return Object.values(value).flatMap(child => strings(child, seen))
  }
  walk(ast, node => {
    if (node.type !== 'JSXOpeningElement') return
    const attributes = (node.attributes as SyntaxNode[]).filter(attribute => attribute.type === 'JSXAttribute')
    const attribute = (name: string) => attributes.find(item => isNode(item.name) && item.name.name === name)
    const classes = strings(attribute('className')?.value).flatMap(value => value.split(/\s+/))
    const backgrounds = classes.filter(value => /(?:^|:)bg-/.test(value) && !/(?:^|:)bg-(?:clip-|transparent(?:$|!)|none(?:$|!))/.test(value))
    const role = attribute('data-surface')
    if (backgrounds.length && !role) report(node, 'A background needs a data-surface owner or inherited role.')
    if (role && (!strings(role.value).length || strings(role.value).some(value => !surfaceKinds.has(value)))) report(node, 'Unknown data-surface role.')
    if (!file.startsWith('src/components/ui/') && isNode(node.name) && uiComponents.has(String(node.name.name)) && (role || classes.some(value => /(?:^|:)(?:bg-|backdrop-)/.test(value)))) {
      report(node, 'Compose UI variants/states instead of overriding a base component background/filter.')
    }
    for (const value of classes) {
      if (value.includes('dark:') && /(?:^|:)bg-/.test(value)) report(node, 'Dark backgrounds must come from theme tokens.')
      if (/(?:^|:)backdrop-/.test(value) || /(?:^|:)surface-/.test(value)) report(node, 'Declare data-surface; the shared material owns its filter.')
      const background = value.match(/(?:^|:)bg-(\[[^\]]+\]|[^:!]+)/)?.[1]
      if (background && !background.startsWith('clip-') && !['transparent', 'none'].includes(background)) {
        const variable = background.match(/^\[var\(--([\w-]+)\)\]$/)?.[1]
        if (!(variable ? tokens.has(variable) : colors.has(background))) report(node, `Background ${background} is not a declared design token.`)
        const paint = variable ?? background
        if (!paint.startsWith('state-') && role && !strings(role.value).some(kind => surfacePaint[kind]?.has(paint))) report(node, `Background ${paint} does not belong to the declared surface layer.`)
        if (['background', 'primary', 'window-background'].includes(background) && !strings(role?.value).includes('inherited')) report(node, 'Opaque/window paint cannot replace a component material.')
      }
      if (/(?:^|:)(?:text|border|ring|fill|stroke)-\[(?:#|rgb|hsl|oklch)/.test(value) || /(?:^|:)(?:text|border|ring|fill|stroke)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d+)(?:\/|$)/.test(value)) {
        report(node, 'Component colors must use design tokens.')
      }
      const shadow = value.match(/(?:^|:)shadow-([^:!]+)/)?.[1]
      if (shadow && shadow !== 'none' && !shadows.has(shadow)) report(node, 'Component shadows must use design tokens.')
    }
    walk(attribute('style')?.value, property => {
      if (property.type !== 'ObjectProperty' || !isNode(property.key)) return
      const key = String(property.key.name ?? property.key.value)
      if (['background', 'backgroundColor', 'backdropFilter', 'WebkitBackdropFilter', 'boxShadow', 'color', 'borderColor'].includes(key)) {
        if (!strings(property.value).every(value => tokens.has(value.match(/^var\(--([\w-]+)\)$/)?.[1] ?? '')) || !strings(property.value).length) report(node, 'Inline material/color styles must reference a declared design token.')
        if (key.includes('backdrop') || key.includes('Backdrop')) report(node, 'Inline filters bypass the shared material.')
        if ((key === 'background' || key === 'backgroundColor') && !role) report(node, 'An inline background needs a data-surface role.')
      }
    })
  })
  return [...errors]
}

export function checkSurfaceFiles(root: string): string[] {
  const css = readFileSync(resolve(root, 'src/index.css'), 'utf8')
  function files(directory: string): string[] {
    return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(`${directory}/${entry.name}`) : entry.name.endsWith('.tsx') ? [`${directory}/${entry.name}`] : [])
  }
  return files('src').flatMap(file => inspectSurfaceContract(readFileSync(resolve(root, file), 'utf8'), file, css))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkSurfaceFiles(fileURLToPath(new URL('../', import.meta.url)))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Surface contract: all component backgrounds use declared shared materials.')
}
