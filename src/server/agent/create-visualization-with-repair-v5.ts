import OpenAI from 'openai'
import type {
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

export type { ChecklistItem }

// ---------------------------------------------------------------------------
// Main export — multi-turn conversation using OpenAI Responses API
// ---------------------------------------------------------------------------

export async function generateVisualizationCodeV5(args: {
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
    'You are an autonomous code-generation agent. You receive a checklist and current code state.',
    '',
    '# Task',
    '- Work through uncompleted checklist items in order using find_and_replace.',
    '- After fully implementing each item, call markChecklistItemDone with its id.',
    '- When all checklist items are done, stop making tool calls.',
    '',
    '# Autonomy and Persistence',
    '- Persist until ALL checklist items are fully implemented end-to-end within the current turn: do not stop at analysis or partial fixes; carry changes through implementation and verification.',
    '- Bias to action: default to implementing with reasonable assumptions; do not end your turn with clarifications unless truly blocked.',
    '- If a find_and_replace fails, use view_range or search_code to inspect actual code, then retry with corrected old_string.',
    '- Avoid excessive looping or repetition; if you find yourself re-reading or re-editing the same files without clear progress, re-read the code and plan the full change before retrying.',
    '',
    '# Efficient Edits',
    '- ALWAYS inspect code with view_range or search_code before calling find_and_replace when in skeleton mode.',
    '- Your find_and_replace old_string must match the ACTUAL code, not the skeleton.',
    '- Batch related changes into one find_and_replace with enough surrounding context to make the match unique.',
    '- Avoid repeated micro-edits to the same region — plan the complete change and apply it in one pass.',
    '',
    '# Critical Rules (violations crash the app)',
    '',
    '## THREE IS NOT AVAILABLE',
    '- NEVER use THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything.',
    '- For vectors, use plain arrays: [x, y, z]. For colors, use hex strings.',
    '- Only these variables are in scope: React, runtimeState, helpers.',
    '',
    '## React Element Rules',
    '- Every React.createElement() call MUST have a valid first argument: string tag or component.',
    '- NEVER write React.createElement( React.createElement(...) ).',
    '- All new elements MUST be children INSIDE the existing React.createElement(React.Fragment, null, ...).',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers.',
    '',
    '## Code Viewing',
    '- When code is short, you see full code. When longer, you see a SKELETON with [line] ranges.',
    '- The skeleton includes insertion hints (last lines before the Fragment close).',
    '- Use view_range (max 80 lines) to inspect ONLY the section you plan to edit.',
    '- Use search_code to find specific patterns instead of scanning large ranges.',
    '- Do NOT view the entire file in chunks — the skeleton shows the structure.',
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

  console.log('[v4] instructions test :', instructions)

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
        model: 'gpt-5.3-codex',
        instructions,
        input: nextInput,
        tools: editTools,
        parallel_tool_calls: false,
        reasoning: { effort: 'medium' },
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      })

      previousResponseId = response.id

      console.log('[v4] response test :', JSON.stringify(response, null, 2))

      console.log(`[v4] iteration ${iteration} status: ${response.status}`)

      const functionCalls = response.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      if (functionCalls.length === 0) {
        // Detect phase on assistant message items (gpt-5.3-codex feature).
        // phase: "commentary" = normal preamble/thinking (model will follow up with tool calls)
        // phase: "final_answer" = model thinks it's done
        const messageItems = response.output.filter((o) => o.type === 'message')
        const phase = (messageItems[0] as any)?.phase as string | null | undefined

        console.log(
          `[v4] no tool calls — phase: ${phase}, output: ${JSON.stringify(response.output, null, 2)}`,
        )

        if (checklist.every((i) => i.done)) {
          console.log('[v4] all items done — stopping')
          break
        }

        // Commentary phase is normal preamble behavior for gpt-5.3-codex.
        // The model is thinking/planning before making tool calls.
        // Don't count it against consecutiveNoToolCalls — just continue.
        if (phase === 'commentary') {
          console.log('[v4] commentary phase (preamble) — continuing normally')
          nextInput = [{ role: 'user' as const, content: 'Continue.' }]
          continue
        }

        // final_answer or null phase with no tool calls — model thinks it's done
        consecutiveNoToolCalls++
        console.log(`[v4] non-commentary no-tool-call (consecutive: ${consecutiveNoToolCalls})`)

        if (consecutiveNoToolCalls >= 3) {
          console.warn('[v4] giving up — no tool calls in 3 consecutive non-commentary rounds')
          break
        }

        const pending = checklist.filter((i) => !i.done)
        const { label, content } = formatCodeState(state.currentCode)

        // Send a focused redirect with full context — the model lost track
        nextInput = [
          {
            role: 'user' as const,
            content: [
              `There are ${pending.length} uncompleted checklist items remaining:`,
              ...pending.map((i) => `- \`${i.id}\`: ${i.description}`),
              '',
              `=== ${label} ===`,
              content,
              `=== END ${label} ===`,
              '',
              'Continue implementing the next uncompleted item using find_and_replace. Call markChecklistItemDone when done.',
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
        const output = executeToolCall(fc.name, toolArgs, state, checklist, '[v4]')
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
        model: 'gpt-5.3-codex',
        instructions,
        input: repairInput,
        tools: editTools,
        parallel_tool_calls: false,
        reasoning: { effort: 'high' },
      })

      const repairCalls = repairResponse.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      console.log(`[v4] repair attempt ${attempt}: ${repairCalls.length} tool calls`)

      for (const fc of repairCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const output = executeToolCall(fc.name, toolArgs, state, checklist, '[v4]')
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
