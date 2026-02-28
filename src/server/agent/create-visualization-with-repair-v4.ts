import OpenAI from 'openai'
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'
import type { VisualizationValidationError } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'
import {
  type ChecklistItem,
  addLineNumbers,
  formatChecklist,
  editTools,
  executeToolCall,
  formatCodeState,
} from './viz-edit-utils'
import { formatBoilerplatesForPrompt, getSceneBoilerplate } from './webgl-boilerplates'

export type { ChecklistItem }

const insertBoilerplateTool: FunctionTool = {
  type: 'function',
  name: 'insert_boilerplate',
  description:
    'Insert a predefined scene boilerplate by key. Use this to quickly start with a known-good template, then adapt it to the blueprint.',
  strict: false,
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Boilerplate key (for example: webgl_3d_real_globe_v1).',
      },
      mode: {
        type: 'string',
        description: 'Insertion mode: "replace_if_empty" (default), "replace_all", or "append".',
      },
    },
    required: ['key'],
  },
}

const v4Tools: FunctionTool[] = [...editTools, insertBoilerplateTool]

function executeToolCallV4(
  toolName: string,
  args: Record<string, unknown>,
  state: { currentCode: string },
  checklist: ChecklistItem[],
  renderType: RenderType,
): string {
  if (toolName === 'insert_boilerplate') {
    const { key, mode } = args as { key: string; mode?: string }
    const selected = getSceneBoilerplate(key, renderType)
    if (!selected) {
      return JSON.stringify({
        success: false,
        error: `Unknown boilerplate key "${key}" for render type ${renderType}.`,
      })
    }

    const insertionMode = mode ?? 'replace_if_empty'
    if (!['replace_if_empty', 'replace_all', 'append'].includes(insertionMode)) {
      return JSON.stringify({
        success: false,
        error: `Invalid mode "${insertionMode}". Use replace_if_empty, replace_all, or append.`,
      })
    }

    if (insertionMode === 'replace_if_empty' && state.currentCode.trim().length > 0) {
      return JSON.stringify({
        success: false,
        error: 'Code is not empty. Use mode "replace_all" or "append" if you want to insert now.',
      })
    }

    if (insertionMode === 'append') {
      state.currentCode = state.currentCode ? `${state.currentCode}\n\n${selected.code}` : selected.code
    } else {
      state.currentCode = selected.code
    }

    console.log(`[v4] insert_boilerplate: ${selected.key} (${insertionMode})`)
    return JSON.stringify({
      success: true,
      key: selected.key,
      mode: insertionMode,
      lines: state.currentCode.split('\n').length,
    })
  }

  return executeToolCall(toolName, args, state, checklist, '[v4]')
}

// ---------------------------------------------------------------------------
// Main export — multi-turn conversation using OpenAI Responses API
// ---------------------------------------------------------------------------

export async function generateVisualizationCodeV4(args: {
  openaiClient: OpenAI
  blueprint: string
  checklist: ChecklistItem[]
  renderType: RenderType
  userPrompt: string
  runtimePanels?: boolean
}): Promise<
  | { ok: true; code: string; checklist: ChecklistItem[] }
  | { ok: false; error: VisualizationValidationError }
> {
  const checklist = args.checklist
  if (checklist.length === 0) {
    console.warn('[v4] empty checklist')
    return { ok: false, error: { phase: 'schema', message: 'Empty implementation checklist.' } }
  }

  console.log('[v4] starting with checklist:', checklist.map((i) => i.id))

  const state = { currentCode: '' }
  const renderRules = getRenderTypeRules(args.renderType).join('\n')
  const availableBoilerplates = formatBoilerplatesForPrompt(args.renderType)
  const globeHintRegex = /\b(earth|globe|world|geography|latitude|longitude|tectonic|climate)\b/i
  const recommendedBoilerplate = globeHintRegex.test(`${args.userPrompt}\n${args.blueprint}`)
    ? 'webgl_3d_real_globe_v1'
    : null

  // ---- System instructions (sent once, cached by OpenAI) ----
  const is3D = args.renderType === '3D_WEBGL'
  const codeStructureGuide = is3D
    ? [
        'CODE STRUCTURE (3D_WEBGL):',
        'The code runs inside a function body with React, runtimeState, and helpers already in scope.',
        'ONLY React, runtimeState, and helpers are available. THREE is NOT in scope.',
        'Use R3F string tags ("mesh", "sphereGeometry", "meshStandardMaterial", etc.) with React.createElement.',
        'Define an inner Scene function and return it:',
        '',
        '  function Scene() {',
        '    const { useFrame, ScreenOverlay, InfoPoint } = helpers;',
        '    // state, refs, effects here',
        '    return React.createElement(React.Fragment, null,',
        '      // ALL visual elements',
        '    );',
        '  }',
        '  return Scene;',
        '',
        'The return statement is the MOST IMPORTANT part — it must contain ALL rendered elements.',
      ].join('\n')
    : [
        'CODE STRUCTURE (2D_CANVAS):',
        'The code runs inside a function body with ctx, canvas, runtimeState, and helpers already in scope.',
        'Draw everything using ctx (fillRect, arc, lineTo, fillText, etc.).',
        'The function is called every frame — draw the full scene each time.',
      ].join('\n')

  const instructions = [
    'You are a code-generation agent. You receive a checklist and current code state.',
    'Use find_and_replace to write and edit code. Work through uncompleted checklist items in order.',
    'If a predefined template fits, call insert_boilerplate first, then customize it with find_and_replace.',
    'After fully implementing a checklist item, call markChecklistItemDone with its id.',
    'Do NOT explain, narrate, or send text-only responses. Just make tool calls.',
    'When all checklist items are done, stop making tool calls.',
    '',
    'CRITICAL RULES (violations crash the app):',
    '',
    'THREE IS NOT AVAILABLE:',
    '- NEVER use THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything.',
    '- For vectors, use plain arrays: [x, y, z]. For colors, use hex strings.',
    '- Only these variables are in scope: React, runtimeState, helpers.',
    '',
    'REACT ELEMENT RULES:',
    '- Every React.createElement() call MUST have a valid first argument: string tag or component.',
    '- NEVER write React.createElement( React.createElement(...) ).',
    '- All new elements MUST be children INSIDE the existing React.createElement(React.Fragment, null, ...).',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers.',
    '',
    'CODE VIEWING:',
    '- When code is short, you see full code. When longer, you see a SKELETON with [line] ranges.',
    '- The skeleton includes insertion hints (last lines before the Fragment close).',
    '- Use view_range (max 80 lines) to inspect ONLY the section you plan to edit.',
    '- Use search_code to find specific patterns instead of scanning large ranges.',
    '- Do NOT view the entire file in chunks — the skeleton shows the structure.',
    '- ALWAYS inspect the actual code before calling find_and_replace when in skeleton mode.',
    '- Your find_and_replace old_string must match the ACTUAL code, not the skeleton.',
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
    `=== AVAILABLE BOILERPLATES (${args.renderType}) ===`,
    availableBoilerplates,
    `=== END AVAILABLE BOILERPLATES ===`,
    ...(recommendedBoilerplate
      ? [
          '',
          `Recommended for this prompt: ${recommendedBoilerplate}`,
          'If you use it, call insert_boilerplate with mode "replace_if_empty" before other edits.',
        ]
      : []),
  ].join('\n')

  // ---- Initial user message ----
  const { label: codeLabel, content: codeContent } = formatCodeState(state.currentCode)

  const initialInput: ResponseInputItem[] = [
    {
      role: 'user',
      content: [
        'Implement the visualization code according to the checklist below.',
        'Work through items in order. After fully implementing each item, call markChecklistItemDone.',
        '',
        '=== CHECKLIST ===',
        formatChecklist(checklist),
        '=== END CHECKLIST ===',
        '',
        `=== ${codeLabel} ===`,
        codeContent,
        `=== END ${codeLabel} ===`,
        '',
        `User request: ${args.userPrompt}`,
        '',
        'IMPORTANT: When adding new elements, place them INSIDE the existing return React.createElement(React.Fragment, null, ...) as additional comma-separated children.',
        '',
        'Begin implementing the first uncompleted checklist item.',
      ].join('\n'),
    },
  ]

  // ---- Main loop: multi-turn conversation with previous_response_id ----
  const MAX_ITERATIONS = 100
  const CODE_STATE_INTERVAL = 8 // inject code state every N rounds
  const maxValidationAttempts = 3
  let iteration = 0
  let consecutiveNoToolCalls = 0
  let previousResponseId: string | undefined
  let nextInput: ResponseInputItem[] = initialInput

  console.log('[v4] instructions length:', instructions.length)

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++

      const allDone = checklist.every((i) => i.done)
      if (allDone) {
        console.log('[v4] all checklist items done')
        break
      }

      console.log(
        `[v4] iteration ${iteration}, pending: ${checklist.filter((i) => !i.done).map((i) => i.id).join(', ')}`,
      )

      const response = await args.openaiClient.responses.create({
        model: 'gpt-5.2',
        instructions,
        input: nextInput,
        tools: v4Tools,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      })

      previousResponseId = response.id

      console.log(`[v4] iteration ${iteration} status: ${response.status}`)

      const functionCalls = response.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      if (functionCalls.length === 0) {
        consecutiveNoToolCalls++
        console.log(
          `[v4] no tool calls (consecutive: ${consecutiveNoToolCalls})`,
        )

        if (checklist.every((i) => i.done)) {
          console.log('[v4] all items done — stopping')
          break
        }

        if (consecutiveNoToolCalls >= 3) {
          console.warn('[v4] giving up — no tool calls in 3 consecutive rounds')
          break
        }

        // Nudge the model with a reminder
        const pending = checklist.filter((i) => !i.done)
        nextInput = [
          {
            role: 'user',
            content: [
              'You stopped making tool calls but these checklist items are NOT done yet:',
              ...pending.map((i) => `- \`${i.id}\`: ${i.description}`),
              '',
              'Continue implementing them. Use find_and_replace to make edits.',
              'Call markChecklistItemDone when each item is complete.',
            ].join('\n'),
          },
        ]
        continue
      }

      consecutiveNoToolCalls = 0

      // Execute tool calls — only send function_call_output items back.
      // With previous_response_id, the function_call items are already part
      // of the conversation; re-sending them causes a duplicate ID error.
      const toolResults: ResponseInputItem[] = []

      for (const fc of functionCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const output = executeToolCallV4(fc.name, toolArgs, state, checklist, args.renderType)
        console.log(`[v4] ${fc.name}: ${output.substring(0, 200)}`)

        toolResults.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output,
        })
      }

      nextInput = toolResults

      // Periodically inject code state so the model stays oriented
      if (iteration % CODE_STATE_INTERVAL === 0 && state.currentCode) {
        const { label, content } = formatCodeState(state.currentCode)
        const pending = checklist.filter((i) => !i.done)
        nextInput.push({
          role: 'user',
          content: [
            `--- Code state checkpoint (${state.currentCode.split('\n').length} lines) ---`,
            '',
            `=== ${label} ===`,
            content,
            `=== END ${label} ===`,
            '',
            '=== CHECKLIST PROGRESS ===',
            formatChecklist(checklist),
            '=== END CHECKLIST PROGRESS ===',
            '',
            `Continue implementing: ${pending.map((i) => i.id).join(', ')}`,
          ].join('\n'),
        })
        console.log(`[v4] injected code state checkpoint at iteration ${iteration}`)
      }

      console.log(
        `[v4] code: ${state.currentCode.split('\n').length} lines, progress: ${checklist.filter((i) => i.done).length}/${checklist.length}`,
      )
    }

    // ---- Validation + repair ----
    console.log('[v4] starting validation phase')

    for (let attempt = 1; attempt <= maxValidationAttempts; attempt++) {
      const validation = validateGeneratedSceneCode(state.currentCode, args.renderType, { runtimePanels: args.runtimePanels })
      if (validation.ok) {
        console.log('[v4] validation passed')
        break
      }

      console.log(`[v4] validation failed (attempt ${attempt}): ${(validation as { ok: false; error: VisualizationValidationError }).error.message}`)

      if (attempt === maxValidationAttempts) {
        console.warn('[v4] validation failed after all repair attempts')
        return { ok: false, error: (validation as { ok: false; error: VisualizationValidationError }).error }
      }

      // Repair: fresh conversation (no previous_response_id) for focused fix
      const repairInput: ResponseInputItem[] = [
        {
          role: 'user',
          content: [
            'The code has a validation error. Fix it.',
            '',
            `Error: ${(validation as { ok: false; error: VisualizationValidationError }).error.phase}: ${(validation as { ok: false; error: VisualizationValidationError }).error.message}`,
            (validation as { ok: false; error: VisualizationValidationError }).error.details
              ? `Details: ${(validation as { ok: false; error: VisualizationValidationError }).error.details!.join(', ')}`
              : '',
            '',
            '=== CURRENT CODE ===',
            addLineNumbers(state.currentCode),
            '=== END CURRENT CODE ===',
            '',
            'Fix the error using find_and_replace.',
          ].join('\n'),
        },
      ]

      const repairResponse = await args.openaiClient.responses.create({
        model: 'gpt-5.2',
        instructions,
        input: repairInput,
        tools: v4Tools,
      })

      const repairCalls = repairResponse.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      console.log(`[v4] repair attempt ${attempt}: ${repairCalls.length} tool calls`)

      for (const fc of repairCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const output = executeToolCallV4(fc.name, toolArgs, state, checklist, args.renderType)
        console.log(`[v4] repair ${fc.name}: ${output.substring(0, 200)}`)
      }
    }
  } catch (error) {
    console.error('[v4] agent run failed', error)
  }

  // Final safety validation
  const finalValidation = validateGeneratedSceneCode(state.currentCode, args.renderType, { runtimePanels: args.runtimePanels })
  if (!finalValidation.ok) {
    console.warn('[v4] final code failed validation', (finalValidation as { ok: false; error: VisualizationValidationError }).error)
    return { ok: false, error: (finalValidation as { ok: false; error: VisualizationValidationError }).error }
  }

  const completed = checklist.filter((i) => i.done).length
  console.log(`[v4] finished: ${completed}/${checklist.length} items completed`)

  return { ok: true, code: state.currentCode, checklist }
}
