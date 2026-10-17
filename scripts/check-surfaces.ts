import { parse } from '@babel/parser'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

type SyntaxNode = { type: string; start?: number; [key: string]: unknown }
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
  const variables = new Map<string, unknown>()
  const tokens = new Set(Array.from(css.matchAll(/--([a-z][\w-]*)\s*:/g), match => match[1]))
  const colors = new Set(Array.from(css.matchAll(/--color-([\w-]*)\s*:/g), match => match[1]))
  const errors = new Set<string>()
  const report = (node: SyntaxNode, reason: string) => errors.add(`${file}:${source.slice(0, node.start ?? 0).split('\n').length}: ${reason}`)
  walk(ast, node => {
    if (node.type === 'VariableDeclarator' && isNode(node.id) && typeof node.id.name === 'string') variables.set(node.id.name, node.init)
    if (node.type === 'ImportDeclaration' && isNode(node.source) && /^(?:radix-ui|@radix-ui\/)/.test(String(node.source.value))) {
      report(node, 'Use the shared Base UI components instead of Radix primitives.')
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
    for (const value of classes) {
      if (/(?:^|:)backdrop-(?!none(?:$|!))/.test(value)) report(node, 'Use the default opaque component surfaces; backdrop filters are retired.')
      const background = value.match(/(?:^|:)bg-(\[[^\]]+\]|[^:!]+)/)?.[1]
      if (background && !background.startsWith('clip-') && !['transparent', 'none', 'inherit', 'current'].includes(background)) {
        const paint = background.replace(/\/(?:\d+|\[[^\]]+\])$/, '')
        const variable = paint.match(/^(?:\[var\(--([\w-]+)\)\]|\(--([\w-]+)\))$/)
        const references = [...paint.matchAll(/var\(--([\w-]+)\)/g)]
        const expression = paint.replace(/var\(--[\w-]+\)/g, 'TOKEN').replace(/color-mix|in_oklch|oklch|from_|calc|TOKEN|c|h/g, '')
        const tokenDerived = paint.startsWith('[') && references.length > 0 && references.every(match => tokens.has(match[1])) && /^[\[\]()_,.\d%*+\-/\s]*$/.test(expression)
        if (!(variable ? tokens.has(variable[1] ?? variable[2]) : colors.has(paint) || tokenDerived)) report(node, `Background ${background} is not a declared design token.`)
      }
      if (/(?:^|:)(?:text|border|ring|fill|stroke)-\[(?:#|rgb|hsl|oklch)/.test(value) || /(?:^|:)(?:text|border|ring|fill|stroke)-(?:white|black|(?:red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone)-\d+)(?:\/|$)/.test(value)) {
        report(node, 'Component colors must use semantic design tokens.')
      }
    }
    walk(attribute('style')?.value, property => {
      if (property.type !== 'ObjectProperty' || !isNode(property.key)) return
      const key = String(property.key.name ?? property.key.value)
      if (['background', 'backgroundColor', 'backdropFilter', 'WebkitBackdropFilter', 'boxShadow', 'color', 'borderColor'].includes(key)) {
        const values = strings(property.value)
        if (!values.length || values.some(value => !['transparent', 'none', 'inherit', 'currentColor'].includes(value) && !tokens.has(value.match(/^var\(--([\w-]+)\)$/)?.[1] ?? ''))) report(node, 'Inline colors must reference a declared design token.')
        if ((key.includes('backdrop') || key.includes('Backdrop')) && values.some(value => value !== 'none')) report(node, 'Backdrop filters are retired; use the default opaque component surfaces.')
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
  const errors = files('src').flatMap(file => inspectSurfaceContract(readFileSync(resolve(root, file), 'utf8'), file, css))
  if ([...css.matchAll(/(?:-webkit-)?backdrop-filter\s*:\s*([^;]+);/g)].some(match => match[1].trim() !== 'none')) errors.push('src/index.css: Backdrop filters are retired; use the default opaque component surfaces.')
  return errors
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkSurfaceFiles(fileURLToPath(new URL('../', import.meta.url)))
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Surface contract: semantic design tokens and Base UI components.')
}
