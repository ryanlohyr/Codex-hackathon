import { useState, useEffect, useCallback } from 'react'
import type {
  ScaffoldStep,
  VisualizationTheme,
  VisualizationRuntimeState,
} from '../../types/visualization'

// ---------------------------------------------------------------------------
// Safe expression evaluator — no eval/Function, pure parsing
// Supports: numbers, identifiers, comparison operators, && / ||
// ---------------------------------------------------------------------------

type Token =
  | { type: 'number'; value: number }
  | { type: 'ident'; value: string }
  | { type: 'op'; value: string }

function tokenize(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  while (i < expr.length) {
    const ch = expr[i]

    // Whitespace
    if (/\s/.test(ch)) {
      i++
      continue
    }

    // Number (including negative after operator)
    if (/[\d.]/.test(ch) || (ch === '-' && (tokens.length === 0 || tokens[tokens.length - 1].type === 'op'))) {
      let num = ''
      if (ch === '-') {
        num = '-'
        i++
      }
      while (i < expr.length && /[\d.]/.test(expr[i])) {
        num += expr[i]
        i++
      }
      tokens.push({ type: 'number', value: parseFloat(num) })
      continue
    }

    // Identifier (variable name)
    if (/[a-zA-Z_]/.test(ch)) {
      let ident = ''
      while (i < expr.length && /[a-zA-Z_0-9]/.test(expr[i])) {
        ident += expr[i]
        i++
      }
      // Handle boolean literals
      if (ident === 'true') {
        tokens.push({ type: 'number', value: 1 })
      } else if (ident === 'false') {
        tokens.push({ type: 'number', value: 0 })
      } else {
        tokens.push({ type: 'ident', value: ident })
      }
      continue
    }

    // Multi-char operators
    const twoChar = expr.slice(i, i + 3)
    if (twoChar === '===') {
      tokens.push({ type: 'op', value: '===' })
      i += 3
      continue
    }
    const pair = expr.slice(i, i + 2)
    if (pair === '>=' || pair === '<=' || pair === '==' || pair === '!=' || pair === '&&' || pair === '||') {
      tokens.push({ type: 'op', value: pair })
      i += 2
      continue
    }

    // Single-char operators
    if (ch === '>' || ch === '<') {
      tokens.push({ type: 'op', value: ch })
      i++
      continue
    }

    // Skip unknown characters
    i++
  }
  return tokens
}

function resolveValue(token: Token, params: Record<string, unknown>): number {
  if (token.type === 'number') return token.value
  if (token.type === 'ident') {
    const val = params[token.value]
    if (typeof val === 'number') return val
    if (typeof val === 'boolean') return val ? 1 : 0
    return 0
  }
  return 0
}

function evalComparison(left: number, op: string, right: number): boolean {
  switch (op) {
    case '>': return left > right
    case '<': return left < right
    case '>=': return left >= right
    case '<=': return left <= right
    case '===':
    case '==': return left === right
    case '!=': return left !== right
    default: return false
  }
}

/**
 * Evaluate a simple condition expression against params.
 * Supports: `variable > 50`, `a > 1 && b < 5`, `x >= 10 || y <= 3`
 */
export function evaluateCondition(
  expr: string,
  params: Record<string, unknown>,
): boolean {
  try {
    const tokens = tokenize(expr)
    if (tokens.length === 0) return false

    // Parse into sub-expressions separated by && / ||
    const groups: { tokens: Token[]; joinOp?: '&&' | '||' }[] = []
    let current: Token[] = []

    for (const token of tokens) {
      if (token.type === 'op' && (token.value === '&&' || token.value === '||')) {
        groups.push({ tokens: current, joinOp: token.value as '&&' | '||' })
        current = []
      } else {
        current.push(token)
      }
    }
    groups.push({ tokens: current })

    // Evaluate each group as a simple comparison: left op right
    let result = evaluateGroup(groups[0].tokens, params)

    for (let i = 1; i < groups.length; i++) {
      const groupResult = evaluateGroup(groups[i].tokens, params)
      const joinOp = groups[i - 1].joinOp
      if (joinOp === '&&') {
        result = result && groupResult
      } else {
        result = result || groupResult
      }
    }

    return result
  } catch {
    return false
  }
}

function evaluateGroup(tokens: Token[], params: Record<string, unknown>): boolean {
  // Single value: truthy check
  if (tokens.length === 1) {
    return resolveValue(tokens[0], params) !== 0
  }
  // Comparison: left op right
  if (tokens.length === 3 && tokens[1].type === 'op') {
    const left = resolveValue(tokens[0], params)
    const right = resolveValue(tokens[2], params)
    return evalComparison(left, tokens[1].value, right)
  }
  // Fallback: try to parse as truthy
  return resolveValue(tokens[0], params) !== 0
}

// ---------------------------------------------------------------------------
// RuntimeStepsPanel
// ---------------------------------------------------------------------------

type RuntimeStepsPanelProps = {
  steps: ScaffoldStep[]
  theme?: VisualizationTheme
  runtimeState: VisualizationRuntimeState
}

export function RuntimeStepsPanel({
  steps,
  theme,
  runtimeState,
}: RuntimeStepsPanelProps) {
  const [stepIndex, setStepIndex] = useState(0)
  const [, setRenderTick] = useState(0)

  const isLight = theme === 'light'

  // Poll runtimeState.params to re-evaluate conditions
  useEffect(() => {
    const interval = setInterval(() => {
      setRenderTick((t) => t + 1)
    }, 500)
    return () => clearInterval(interval)
  }, [])

  // Sync step index to runtimeState so generated code can read it
  useEffect(() => {
    runtimeState.params.__stepIndex = stepIndex
  }, [stepIndex, runtimeState])

  const panelBg = isLight ? 'rgba(250, 245, 235, 0.92)' : 'rgba(15, 23, 42, 0.85)'
  const panelBorder = isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.12)'
  const textPrimary = isLight ? '#1e293b' : '#e2e8f0'
  const textMuted = isLight ? '#64748b' : '#94a3b8'

  if (steps.length === 0) return null

  const currentStep = steps[stepIndex]
  const conditionMet = evaluateCondition(currentStep.condition, runtimeState.params)

  const goBack = useCallback(() => {
    setStepIndex((i) => Math.max(0, i - 1))
  }, [])

  const goForward = useCallback(() => {
    setStepIndex((i) => Math.min(steps.length - 1, i + 1))
  }, [steps.length])

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        right: 16,
        width: 360,
        zIndex: 20,
        background: panelBg,
        border: `1px solid ${panelBorder}`,
        borderRadius: 12,
        padding: 16,
        color: textPrimary,
        fontFamily: 'system-ui, sans-serif',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        pointerEvents: 'auto',
      }}
    >
      {/* Panel title */}
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: textMuted,
          marginBottom: 10,
        }}
      >
        Scaffolded Steps
      </div>

      {/* Step counter */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontFamily: 'ui-monospace, monospace',
            fontWeight: 700,
          }}
        >
          Step {stepIndex + 1} / {steps.length}
        </div>
      </div>

      {/* Instruction */}
      <div
        style={{
          fontWeight: 800,
          fontSize: 13,
          marginBottom: 8,
          lineHeight: 1.4,
        }}
      >
        {currentStep.instruction}
      </div>

      {/* Concept */}
      <div
        style={{
          fontFamily: "Georgia, 'Times New Roman', serif",
          fontStyle: 'italic',
          color: textMuted,
          fontSize: 13,
          marginBottom: 10,
          lineHeight: 1.4,
        }}
      >
        {currentStep.concept}
      </div>

      {/* Condition status */}
      <div
        style={{
          fontFamily: 'ui-monospace, monospace',
          fontWeight: 800,
          fontSize: 12,
          marginBottom: 12,
          color: conditionMet ? '#16A34A' : '#DC2626',
        }}
      >
        {conditionMet ? 'Condition met' : 'Condition not met'}
      </div>

      {/* Navigation */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <button
          type="button"
          onClick={goBack}
          disabled={stepIndex === 0}
          style={{
            flex: 1,
            background: 'transparent',
            color: stepIndex === 0 ? textMuted : textPrimary,
            border: `1px solid ${panelBorder}`,
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: stepIndex === 0 ? 'default' : 'pointer',
            fontFamily: 'system-ui, sans-serif',
            opacity: stepIndex === 0 ? 0.5 : 1,
          }}
        >
          &larr;
        </button>
        <button
          type="button"
          onClick={goForward}
          disabled={stepIndex === steps.length - 1}
          style={{
            flex: 1,
            background: 'transparent',
            color: stepIndex === steps.length - 1 ? textMuted : textPrimary,
            border: `1px solid ${panelBorder}`,
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: stepIndex === steps.length - 1 ? 'default' : 'pointer',
            fontFamily: 'system-ui, sans-serif',
            opacity: stepIndex === steps.length - 1 ? 0.5 : 1,
          }}
        >
          &rarr;
        </button>
      </div>
    </div>
  )
}
