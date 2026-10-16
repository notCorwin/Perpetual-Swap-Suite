import { bodyPresentation, humanName, ruleSentence } from './filter-builder.ts'
import { expressionTemplates, type ExpressionTemplate } from './filter-expression.ts'
import { comparisons, type EditorExpression, type FilterConfigV2, type FilterMetric, type RuleNode } from './rule-engine.ts'

export function filterRuleSummary(config: FilterConfigV2, metrics: FilterMetric[], expressions: Record<string, EditorExpression>, templates: ExpressionTemplate[] = expressionTemplates): string {
  const summarize = (node: RuleNode): string => {
    const child = () => node.children[0] ? summarize(node.children[0]) : 'No condition'
    let text: string
    switch (node.kind) {
      case 'all': case 'any':
        text = bodyPresentation(node) ? ruleSentence(node, metrics, expressions, templates)
          : !node.children.length ? 'All markets'
          : node.children.length === 1 ? child()
          : `(${node.children.map(summarize).join(node.kind === 'all' ? ' AND ' : ' OR ')})`
        break
      case 'not': text = `NOT (${child()})`; break
      case 'every': text = `${child()} · every hour for ${node.hours}h`; break
      case 'recent': text = `${child()} · at least once in ${node.hours}h`; break
      case 'cooldown': text = `${child()} · cooldown ${node.hours}h${node.hours === 0 ? ' (disabled)' : ''}`; break
      case 'count':
        text = `${child()} · ${node.comparison === 'between' ? `between ${node.minimum} and ${node.upper}` : `${comparisons.find(([key]) => key === node.comparison)?.[1] ?? node.comparison} ${node.minimum}`} times in ${node.hours}h`
        break
      case 'sequence': text = `${node.children.map(stage => `${humanName(stage.name || 'Stage')}: ${summarize(stage)}`).join(' → ')} within ${node.hours}h`; break
      default: text = ruleSentence(node, metrics, expressions, templates)
    }
    return node.mode === 'closed' ? `Closed (${text})` : text
  }
  return summarize(config.root)
}
