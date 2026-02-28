import { generateText, tool } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { VisualizationValidationError } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  id: string
  description: string
  done: boolean
}

function addLineNumbers(code: string): string {
  return code
    .split('\n')
    .map((line, i) => `${i + 1} | ${line}`)
    .join('\n')
}

function formatChecklist(items: ChecklistItem[]): string {
  return items
    .map((item) => `- \`${item.id}\` — ${item.description}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Tools — only writeFullCode for one-shot, edit tools for repair only
// ---------------------------------------------------------------------------

const generateTool = {
  writeFullCode: tool({
    description:
      'Write the complete visualization code. Call this exactly once with the ENTIRE code that implements ALL checklist items.',
    inputSchema: z.object({
      code: z.string().describe('The complete visualization code implementing every checklist item.'),
    }),
  }),
}

const repairTools = {
  str_replace: tool({
    description:
      'Replace an exact substring in the current visualization code. old_str must match exactly including whitespace and newlines.',
    inputSchema: z.object({
      old_str: z.string().describe('Exact substring to find in the current code.'),
      new_str: z.string().describe('Replacement string.'),
    }),
  }),
  insertAfterLineNumber: tool({
    description:
      'Insert new code after a specific line number. Line 0 inserts before the first line.',
    inputSchema: z.object({
      line_number: z.number().describe('Line number after which to insert (0 = before first line).'),
      text: z.string().describe('The code text to insert.'),
    }),
  }),
}

// ---------------------------------------------------------------------------
// Repair tool execution
// ---------------------------------------------------------------------------

function executeRepairToolCall(
  toolName: string,
  args: Record<string, unknown>,
  state: { currentCode: string },
): string {
  if (toolName === 'str_replace') {
    const { old_str, new_str } = args as { old_str: string; new_str: string }
    if (!state.currentCode.includes(old_str)) {
      return JSON.stringify({
        success: false,
        error: 'String not found in code. Make sure old_str matches exactly.',
      })
    }
    state.currentCode = state.currentCode.replace(old_str, new_str)
    console.log(`[generateCodeV3] str_replace: ok (${state.currentCode.split('\n').length} lines)`)
    return JSON.stringify({ success: true, lines: state.currentCode.split('\n').length })
  }

  if (toolName === 'insertAfterLineNumber') {
    const { line_number, text } = args as { line_number: number; text: string }
    const lines = state.currentCode.split('\n')
    if (line_number < 0 || line_number > lines.length) {
      return JSON.stringify({
        success: false,
        error: `Line ${line_number} out of range. Code has ${lines.length} lines (valid: 0-${lines.length}).`,
      })
    }
    lines.splice(line_number, 0, text)
    state.currentCode = lines.join('\n')
    console.log(
      `[generateCodeV3] insertAfterLineNumber at ${line_number}: ok (${state.currentCode.split('\n').length} lines)`,
    )
    return JSON.stringify({ success: true, lines: state.currentCode.split('\n').length })
  }

  return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
}

// ---------------------------------------------------------------------------
// Main export — one-shot generation + validation/repair loop
// ---------------------------------------------------------------------------

export async function generateVisualizationCodeV3(args: {
  openai: ReturnType<typeof createOpenAI>
  blueprint: string
  checklist: ChecklistItem[]
  renderType: RenderType
  userPrompt: string
}): Promise<
  | { ok: true; code: string; checklist: ChecklistItem[] }
  | { ok: false; error: VisualizationValidationError }
> {
  const checklist = args.checklist
  if (checklist.length === 0) {
    console.warn('[generateCodeV3] empty checklist')
    return { ok: false, error: { phase: 'schema', message: 'Empty implementation checklist.' } }
  }

  console.log('[generateCodeV3] starting with checklist:', checklist.map((i) => i.id))

  const state = { currentCode: '' }
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  // ---- Code structure guide ----
  const is3D = args.renderType === '3D_WEBGL'
  const codeStructureGuide = is3D
    ? [
        'CODE STRUCTURE (3D_WEBGL):',
        'The code runs inside a function body with React, runtimeState, and helpers already in scope.',
        'ONLY React, runtimeState, and helpers are available. THREE is NOT in scope — never use THREE.Vector3, THREE.Color, etc.',
        'Use R3F string tags ("mesh", "sphereGeometry", "meshStandardMaterial", "pointLight", "group", etc.) with React.createElement.',
        'You must define an inner Scene function and return it:',
        '',
        '  function Scene() {',
        '    const { useFrame, ScreenOverlay, InfoPoint } = helpers;',
        '    // state, refs, effects here',
        '    return React.createElement(React.Fragment, null,',
        '      // ALL visual elements: meshes, lines, lights, InfoPoints',
        '      // ScreenOverlay with ACTUAL slider/button controls (not placeholder text)',
        '    );',
        '  }',
        '  return Scene;',
        '',
        'The return statement is the MOST IMPORTANT part — it must contain ALL rendered elements.',
        'Every mesh, every InfoPoint, every slider, every panel must be in the JSX tree.',
        'State and helper functions are useless if nothing is rendered.',
      ].join('\n')
    : [
        'CODE STRUCTURE (2D_CANVAS):',
        'The code runs inside a function body with ctx, canvas, runtimeState, and helpers already in scope.',
        'Draw everything using ctx (fillRect, arc, lineTo, fillText, etc.).',
        'The function is called every frame — draw the full scene each time.',
      ].join('\n')

  // ---- System instructions ----
  const systemPrompt = [
    'You are a code-generation agent that writes complete visualization code in a SINGLE pass.',
    'You will receive a blueprint (educational design) and a detailed checklist of everything the code must include.',
    'Your job is to write the ENTIRE code that implements EVERY checklist item. Call the writeFullCode tool exactly once with the complete code.',
    '',
    'Do NOT explain, narrate, or send text-only responses. Just call writeFullCode with the full code.',
    'Do NOT write partial code or skip any checklist items. Every single item must be fully implemented.',
    '',
    'CRITICAL RULES (violations crash the app):',
    '',
    'THREE IS NOT AVAILABLE:',
    '- NEVER use THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything, or any THREE.* reference.',
    '- THREE is NOT in scope. The code runs in React Three Fiber — use R3F intrinsic string tags instead.',
    '- For vectors, use plain arrays: [x, y, z] for position/rotation/scale.',
    '- For colors, use hex strings: "#ff0000" or CSS color names.',
    '- For math, use plain JS: Math.PI, Math.sin(), etc.',
    '- Only these variables are in scope: React, runtimeState, helpers.',
    '',
    'REACT ELEMENT RULES:',
    '- Every React.createElement() call MUST have a valid first argument: a string tag ("mesh", "div") or a component reference (ScreenOverlay, InfoPoint).',
    '- NEVER write React.createElement( React.createElement(...) ) — the inner element becomes the "type" arg, which is invalid.',
    '- All elements MUST be inside the return React.createElement(React.Fragment, null, ...) tree.',
    '- NEVER wrap elements in a new React.createElement() without specifying a tag or component as the first argument.',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers — use them as: React.createElement(ScreenOverlay, null, ...) and React.createElement(InfoPoint, { label: ..., ... })',
  ].join('\n')

  // ---- User prompt ----
  const userMessage = [
    'Write the COMPLETE visualization code that implements ALL of the following checklist items.',
    'Call writeFullCode exactly once with the entire code. Do not skip any item.',
    '',
    '=== CHECKLIST (implement ALL items) ===',
    formatChecklist(checklist),
    '=== END CHECKLIST ===',
    '',
    codeStructureGuide,
    '',
    '=== BLUEPRINT ===',
    args.blueprint,
    '=== END BLUEPRINT ===',
    '',
    '=== RENDERING ENGINE RULES ===',
    renderRules,
    '=== END RENDERING ENGINE RULES ===',
    '',
    `User request: ${args.userPrompt}`,
    '',
    'IMPORTANT: Write ALL the code in a single writeFullCode call. Every checklist item must be implemented.',
    'The code must be complete and self-contained — not a stub or skeleton.',
  ].join('\n')

  console.log('[generateCodeV3] checklist', JSON.stringify(checklist, null, 2))
  console.log('[generateCodeV3] system prompt length:', systemPrompt.length)
  console.log('[generateCodeV3] user message length:', userMessage.length)

  try {
    // ---- One-shot generation ----
    console.log('[generateCodeV3] calling model for one-shot generation...')

    const result = await generateText({
      model: args.openai.responses('gpt-5.3-codex'),
      system: systemPrompt,
      prompt: userMessage,
      tools: generateTool,
      providerOptions: {
        openai: {
          reasoningEffort: 'medium',
        },
      },
    })

    console.log(`[generateCodeV3] finishReason: ${result.finishReason}`)
    console.log(`[generateCodeV3] text: ${result.text}`)
    console.log(`[generateCodeV3] toolCalls:`, result.toolCalls.length)

    const writeCall = result.toolCalls.find((tc) => tc.toolName === 'writeFullCode')
    if (!writeCall) {
      console.error('[generateCodeV3] model did not call writeFullCode')
      return {
        ok: false,
        error: { phase: 'schema', message: 'Model failed to generate code (no writeFullCode call).' },
      }
    }

    const generatedCode = (writeCall.input as { code: string }).code
    state.currentCode = generatedCode

    console.log(`[generateCodeV3] generated code: ${state.currentCode.split('\n').length} lines`)

    // Mark all checklist items as done (one-shot means we attempted all)
    for (const item of checklist) {
      item.done = true
    }

    // ---- Validation + repair loop ----
    const maxRepairAttempts = 3
    const repairSystemPrompt = [
      'You are a code-repair agent. The visualization code has a validation error.',
      'Fix the error using str_replace or insertAfterLineNumber.',
      'Do NOT rewrite the entire code — make targeted fixes only.',
      'Do NOT explain. Just make tool calls to fix the error.',
      '',
      'CRITICAL: THREE is NOT in scope. Never use THREE.* references.',
      'Only React, runtimeState, and helpers are available.',
    ].join('\n')

    console.log('[generateCodeV3] starting validation phase')

    for (let attempt = 1; attempt <= maxRepairAttempts; attempt++) {
      const validation = validateGeneratedSceneCode(state.currentCode, args.renderType)
      if (validation.ok) {
        console.log('[generateCodeV3] validation passed')
        break
      }

      console.log(`[generateCodeV3] validation failed (attempt ${attempt}): ${validation.error.message}`)

      if (attempt === maxRepairAttempts) {
        console.warn('[generateCodeV3] validation failed after all repair attempts')
        return { ok: false, error: validation.error }
      }

      const fixPrompt = [
        'The code has a validation error. Fix it.',
        '',
        `Error: ${validation.error.phase}: ${validation.error.message}`,
        validation.error.details ? `Details: ${validation.error.details.join(', ')}` : '',
        '',
        '=== CURRENT CODE ===',
        addLineNumbers(state.currentCode),
        '=== END CURRENT CODE ===',
        '',
        codeStructureGuide,
        '',
        '=== RENDERING ENGINE RULES ===',
        renderRules,
        '=== END RENDERING ENGINE RULES ===',
        '',
        'Fix the error using str_replace or insertAfterLineNumber.',
      ].join('\n')

      const fixResult = await generateText({
        model: args.openai.responses('gpt-5.3-codex'),
        system: repairSystemPrompt,
        prompt: fixPrompt,
        tools: repairTools,
      })

      const fixCalls = fixResult.toolCalls
      console.log(`[generateCodeV3] repair attempt ${attempt}: ${fixCalls.length} tool calls`)

      for (const fc of fixCalls) {
        const output = executeRepairToolCall(fc.toolName, fc.input as Record<string, unknown>, state)
        console.log(`[generateCodeV3] repair ${fc.toolName}: ${output.substring(0, 200)}`)
      }
    }
  } catch (error) {
    console.error('[generateCodeV3] generation failed', error)
  }

  // Final safety validation
  const finalValidation = validateGeneratedSceneCode(state.currentCode, args.renderType)
  if (!finalValidation.ok) {
    console.warn('[generateCodeV3] final code failed validation', finalValidation.error)
    return { ok: false, error: finalValidation.error }
  }

  const completed = checklist.filter((i) => i.done).length
  console.log(`[generateCodeV3] finished: ${completed}/${checklist.length} items completed`)

  return { ok: true, code: state.currentCode, checklist }
}
