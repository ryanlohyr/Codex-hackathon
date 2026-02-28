import { generateObject } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
import OpenAI from 'openai'
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'
import { z } from 'zod'
import type { VisualizationValidationError } from '../../types/agent'
import type { RenderType, VisualizationControls, ScaffoldStep } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'


// ---------------------------------------------------------------------------
// Metadata generation — extracts config fields from the blueprint
// ---------------------------------------------------------------------------

const jsonPrimitiveSchema = z.union([z.string(), z.number(), z.boolean(), z.null()])
const jsonValueSchema = z.union([jsonPrimitiveSchema, z.array(jsonPrimitiveSchema)])

const sliderDefSchema = z
  .object({
    key: z.string().describe('camelCase param key matching the blueprint Simulation Variables Name column.'),
    label: z.string().describe('Human-readable label from the blueprint Label column.'),
    min: z.number(),
    max: z.number(),
    step: z.number(),
    defaultValue: z.number(),
    unit: z.union([z.string(), z.null()]).describe('Measurement unit string or null when not applicable.'),
  })
  .strict()

const toggleDefSchema = z
  .object({
    key: z.string().describe('camelCase key stored in runtimeState.toggles.'),
    label: z.string().describe('Button label, e.g. "Pause" or "Infall Tracker".'),
    defaultValue: z.boolean(),
  })
  .strict()

const scaffoldStepSchema = z
  .object({
    instruction: z.string().describe('What the student should do.'),
    concept: z.string().describe('What they will learn.'),
    condition: z.string().describe('Logic expression using variable names, e.g. "mass > 50".'),
  })
  .strict()

const visualizationMetadataSchema = z
  .object({
    type: z.enum(['solar-system', 'molecule', 'terrain', 'concept-map']),
    theme: z.enum(['light', 'dark']).describe('Visual theme from the blueprint.'),
    title: z.string().describe('Short title for the visualization.'),
    summary: z.string().describe('One-sentence summary of the visualization.'),
    params: z
      .array(
        z
          .object({
            key: z.string(),
            value: jsonValueSchema,
          })
          .strict(),
      )
      .describe('Simulation variables with default values from the blueprint.'),
    controls: z
      .object({
        title: z.string().describe('Panel title, e.g. "BLACK HOLE CONTROLS". Derive from the visualization topic.'),
        sliders: z.array(sliderDefSchema).describe('One slider per blueprint Simulation Variable.'),
        toggles: z.array(toggleDefSchema).describe('Toggle buttons. Always include isPaused (default false). Add others as needed from blueprint.'),
      })
      .strict()
      .describe('Control panel definition extracted from the blueprint.'),
    scaffoldedSteps: z
      .array(scaffoldStepSchema)
      .describe('Scaffolding steps from the blueprint.'),
  })
  .strict()

export async function generateVisualizationMetadata(args: {
  openai: ReturnType<typeof createOpenAI>
  blueprint: string
  userPrompt: string
}): Promise<{
  type: 'solar-system' | 'molecule' | 'terrain' | 'concept-map'
  theme: 'light' | 'dark'
  title: string
  summary: string
  params: Record<string, unknown>
  controls: VisualizationControls
  scaffoldedSteps: ScaffoldStep[]
}> {
  const { object } = await generateObject({
    model: args.openai.responses('gpt-5.2'),
    schema: visualizationMetadataSchema,
    schemaName: 'mindcanvas_visualization_metadata',
    prompt: [
      'Extract visualization metadata from the blueprint below.',
      '',
      `User request: ${args.userPrompt}`,
      '',
      '=== BLUEPRINT ===',
      args.blueprint,
      '=== END BLUEPRINT ===',
      '',
      'Return the type, theme, title, summary, simulation params with their default values,',
      'control panel definition (sliders from Simulation Variables, toggles including isPaused),',
      'and scaffolded steps from the blueprint.',
    ].join('\n'),
  })

  return {
    type: object.type,
    theme: object.theme,
    title: object.title,
    summary: object.summary,
    params: Object.fromEntries(object.params.map((p) => [p.key, p.value])),
    controls: {
      ...object.controls,
      sliders: object.controls.sliders.map((slider) =>
        slider.unit == null ? { ...slider, unit: undefined } : slider,
      ),
    } as VisualizationControls,
    scaffoldedSteps: object.scaffoldedSteps as ScaffoldStep[],
  }
}

// ---------------------------------------------------------------------------
// Checklist generation — structured AI call to extract implementation tasks
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  id: string
  description: string
  done: boolean
}

const checklistSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().describe('Short snake_case identifier (e.g. "scene_setup", "controls_panel").'),
          description: z.string().describe('Detailed implementation instructions for this task — include exact variable names, position coordinates, hex colors, and interaction details.'),
        })
        .strict(),
    ),
  })
  .strict()

export async function generateChecklist(args: {
  openai: ReturnType<typeof createOpenAI>
  blueprint: string
  renderType: RenderType
}): Promise<ChecklistItem[]> {
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  const { object } = await generateObject({
    model: args.openai.responses('gpt-5.3-codex'),
    schema: checklistSchema,
    schemaName: 'mindcanvas_implementation_checklist',
    prompt: [
      'You are a senior engineer breaking down a visualization into an ordered implementation plan.',
      'Read the blueprint and rendering engine rules below, then produce a checklist of discrete implementation tasks.',
      '',
      'Each checklist item must be a self-contained task that a code-generation agent can implement by writing actual code.',
      'Write each description as if you are giving instructions to a junior developer — be explicit about:',
      '  - Which API calls to use (React.createElement, helpers.ScreenOverlay, helpers.InfoPoint, helpers.useFrame, etc.)',
      '  - Exact variable names, hex colors from the palette, position coordinates [x,y,z], numeric ranges (min/max/default)',
      '  - What the rendered output should look like (e.g. "a blue sphere at [0,2,0] with radius 0.3")',
      '  - How state flows (e.g. "read cPenalty from runtimeState.params, use it to compute margin width")',
      '',
      'ORDER items like a senior engineer would build this:',
      '  1. Scaffold: Scene function skeleton, destructure helpers, define palette object, initialize runtimeState.params defaults from the blueprint simulation variables.',
      '  2. Core visuals: All primary meshes, geometries, materials, particle systems, lines — the main things the student sees. Specify geometry type, material type, color, position, and size for each.',
      '  3. Animation: useFrame logic for continuous motion, interpolation, per-frame state updates. Include exact formulas. Read all values from runtimeState.params and runtimeState.toggles (NOT React.useState — useFrame callbacks are not re-registered on re-render).',
      '  4. Info points: Every InfoPoint from the blueprint with exact label text, explanation text, position [x,y,z], and hex color. Spread them apart (min 2-3 units between any two).',
      '  5. Interactions: onClick/onPointer handlers, drag behavior, hover effects — anything the blueprint describes as interactive.',
      '',
      'IMPORTANT: The engine renders the control panel (sliders, toggles) and scaffolded steps panel automatically.',
      'Do NOT include checklist items for: controls panel, slider UI, button UI, scaffolded steps panel, or step navigation.',
      'The generated code only needs to initialize runtimeState.params defaults and build the 3D scene.',
      '',
      `Render type: ${args.renderType}`,
      '',
      '=== RENDERING ENGINE RULES ===',
      renderRules,
      '=== END RENDERING ENGINE RULES ===',
      '',
      '=== BLUEPRINT ===',
      args.blueprint,
      '=== END BLUEPRINT ===',
    ].join('\n'),
  })

  console.log('[generateChecklist] produced items:', object.items.map((i) => i.id))

  return object.items.map((item) => ({
    id: item.id,
    description: item.description,
    done: false,
  }))
}

// ---------------------------------------------------------------------------
// Iterative code generation — manual agent loop with tools
// The model builds visualization code from scratch using the structured checklist.
// We call the model in a while loop, execute tool calls ourselves, and push
// results back into the messages array — matching the orchestrator pattern.
// ---------------------------------------------------------------------------

function addLineNumbers(code: string): string {
  return code
    .split('\n')
    .map((line, i) => `${i + 1} | ${line}`)
    .join('\n')
}

function formatChecklist(items: ChecklistItem[]): string {
  return items
    .map((item) => `- [${item.done ? 'x' : ' '}] \`${item.id}\` — ${item.description}`)
    .join('\n')
}

// Tool definitions — only edit tools, we control the workflow ourselves
const editTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'str_replace',
    description:
      'Replace an exact substring in the current visualization code. old_str must match exactly including whitespace and newlines.',
    strict: null,
    parameters: {
      type: 'object',
      properties: {
        old_str: { type: 'string', description: 'Exact substring to find in the current code.' },
        new_str: { type: 'string', description: 'Replacement string.' },
      },
      required: ['old_str', 'new_str'],
    },
  },
  {
    type: 'function',
    name: 'insert',
    description:
      'Insert new code after a specific line number. Line 0 inserts before the first line.',
    strict: null,
    parameters: {
      type: 'object',
      properties: {
        insert_line: { type: 'number', description: 'Line number after which to insert (0 = before first line).' },
        insert_text: { type: 'string', description: 'The code text to insert.' },
      },
      required: ['insert_line', 'insert_text'],
    },
  },
]

function executeEditTool(
  toolName: string,
  input: Record<string, unknown>,
  state: { currentCode: string },
): { success: boolean; error?: string; lines?: number } {
  if (toolName === 'str_replace') {
    const { old_str, new_str } = input as { old_str: string; new_str: string }
    if (!state.currentCode.includes(old_str)) {
      return { success: false, error: 'String not found in code. Make sure old_str matches exactly.' }
    }
    state.currentCode = state.currentCode.replace(old_str, new_str)
    return { success: true, lines: state.currentCode.split('\n').length }
  }

  if (toolName === 'insert') {
    const { insert_line, insert_text } = input as { insert_line: number; insert_text: string }
    const lines = state.currentCode.split('\n')
    if (insert_line < 0 || insert_line > lines.length) {
      return {
        success: false,
        error: `Line ${insert_line} out of range. Code has ${lines.length} lines (valid: 0-${lines.length}).`,
      }
    }
    lines.splice(insert_line, 0, insert_text)
    state.currentCode = lines.join('\n')
    return { success: true, lines: state.currentCode.split('\n').length }
  }

  return { success: false, error: `Unknown tool: ${toolName}` }
}

export async function generateVisualizationCode(args: {
  openaiClient: OpenAI
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
    console.warn('[generateCode] empty checklist')
    return { ok: false, error: { phase: 'schema', message: 'Empty implementation checklist.' } }
  }

  console.log('[generateCode] starting with checklist:', checklist.map((i) => i.id))

  const state = { currentCode: '' }
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  const instructions = [
    'You are a code-generation agent. You receive the current code and a SINGLE task to implement.',
    'Call insert and/or str_replace to write ALL the code needed for this task in one response.',
    'Do NOT explain, narrate, or send text-only responses. Just make tool calls.',
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
    '- All new elements MUST be added as children INSIDE the existing React.createElement(React.Fragment, null, ...) return tree.',
    '- To add children: use str_replace to find the last child before the closing ");", then append the new elements as additional comma-separated arguments.',
    '- NEVER wrap elements in a new React.createElement() without specifying a tag or component as the first argument.',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers — use them as: React.createElement(ScreenOverlay, null, ...) and React.createElement(InfoPoint, { label: ..., ... })',
  ].join('\n')

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

  // Reference material included in every call
  const referenceBlock = [
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

  const maxRoundsPerItem = 10
  const maxValidationAttempts = 3

  console.log('checklist', JSON.stringify(checklist, null, 2))
  console.log('instructions', instructions)

  try {
    // ---------- Phase 1: Implement each checklist item ----------
    for (const item of checklist) {
      console.log(`[generateCode] → implementing: ${item.id}`)

      let round = 0
      let consecutiveNoToolCalls = 0
      // Accumulates the model's tool calls + results within this item's while loop
      // so the model has memory of what it did in previous rounds
      let prevRoundContext: ResponseInputItem[] = []

      while (round < maxRoundsPerItem) {
        round++

        // Build fresh input each round with the latest code state
        const currentCodeBlock = state.currentCode
          ? addLineNumbers(state.currentCode)
          : '(empty — use insert at line 0 to write the initial code)'

        const input: ResponseInputItem[] = [
          {
            role: 'user',
            content: [
              `TASK: Implement checklist item \`${item.id}\``,
              item.description,
              '',
              '=== CURRENT CODE ===',
              currentCodeBlock,
              '=== END CURRENT CODE ===',
              '',
              '=== CHECKLIST PROGRESS ===',
              formatChecklist(checklist),
              '=== END CHECKLIST PROGRESS ===',
              '',
              referenceBlock,
              '',
              `User request: ${args.userPrompt}`,
              '',
              'IMPORTANT: When adding new elements, place them INSIDE the existing return React.createElement(React.Fragment, null, ...) as additional comma-separated children.',
              'Find the right insertion point using str_replace — locate the last child element before the closing ); of the Fragment and add your new elements after it.',
              '',
              'Make edits needed for this task using insert and str_replace.',
              'If you have already fully implemented this task in the code above, make no tool calls.',
            ].join('\n'),
          },
        ]

        // Include previous round's tool calls + results so model knows what it already did
        if (prevRoundContext.length > 0) {
          input.push(...prevRoundContext)
          input.push({
            role: 'user',
            content: 'The code above reflects your previous edits. Continue implementing this task — make more edits if needed, or make no tool calls if done.',
          })
        }

        console.log('input', JSON.stringify(input, null, 2))

        const response = await args.openaiClient.responses.create({
          model: 'gpt-5.3-codex',
          instructions,
          input,
          tools: editTools,
        })

        console.log(`[generateCode]   ${item.id} round ${round} status: ${response.status}`)
        console.log('response output', JSON.stringify(response.output, null, 2))

        const functionCalls = response.output.filter(
          (o): o is ResponseFunctionToolCall => o.type === 'function_call',
        )

        // No tool calls = model considers this item done
        if (functionCalls.length === 0) {
          consecutiveNoToolCalls++
          if (consecutiveNoToolCalls >= 2) {
            break
          }
          // Save the text-only output as context too
          prevRoundContext = [...(response.output as ResponseInputItem[])]
          continue
        }

        consecutiveNoToolCalls = 0

        // Execute tool calls, building context for the next round
        const roundContext: ResponseInputItem[] = [...(response.output as ResponseInputItem[])]

        console.log('functionCalls', JSON.stringify(functionCalls, null, 2))

        for (const fc of functionCalls) {
          const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
          const result = executeEditTool(fc.name, toolArgs, state)

          console.log(`[generateCode]   ${fc.name}: ${result.success ? 'ok' : result.error}`)
          console.log('result', JSON.stringify(result, null, 2))

          roundContext.push({
            type: 'function_call_output',
            call_id: fc.call_id,
            output: JSON.stringify(result),
          })
        }

        // Save this round's context so next round sees what we did
        prevRoundContext = roundContext

        // Continue the loop — model may need more rounds to finish this item
      }

      item.done = true
      console.log(`[generateCode]   ✓ ${item.id} done after ${round} rounds (${state.currentCode.split('\n').length} lines)`)
      console.log('current code', state.currentCode)
    }

    // ---------- Phase 2: Code review by a different model ----------
    console.log('[generateCode] starting code review phase')
    const reviewInstructions = [
      'You are a senior React Three Fiber code reviewer for MindCanvas visualizations.',
      'You receive the full generated code, the implementation checklist, and the rendering engine rules.',
      'Your job is to review the code and fix ANYTHING that is wrong or broken.',
      'Call str_replace to fix issues. If the code is perfect, make no tool calls.',
      '',
      '1. THREE.js REFERENCES (instant crash — highest priority):',
      '   - ANY use of THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything() MUST be removed',
      '   - THREE is NOT in scope. Only React, runtimeState, and helpers are available.',
      '   - Replace THREE.Vector3(x,y,z) with plain arrays [x,y,z]',
      '   - Replace THREE.Color("...") with hex strings "#..."',
      '   - Replace new THREE.* constructors with R3F intrinsic elements or plain JS math',
      '',
      '2. STRUCTURAL BUGS (crash the app):',
      '   - React.createElement() without a valid first argument (string tag or component)',
      '   - React.createElement( React.createElement(...) ) — nested element used as "type"',
      '   - ScreenOverlay or InfoPoint used as a bare value instead of React.createElement(Component, props, ...children)',
      '   - Elements outside the return React.createElement(React.Fragment, null, ...) tree',
      '   - Mismatched parentheses — unclosed or extra React.createElement() calls',
      '   - Missing commas between sibling children in React.createElement',
      '   - Variables or functions referenced before declaration',
      '',
      '3. CHECKLIST COMPLETENESS:',
      '   - Verify each checklist item actually has VISIBLE rendered output in the return tree',
      '   - If a checklist item was "done" but the code for it is missing/broken, add the implementation',
      '   - ScreenOverlay controls panel must have ACTUAL working sliders/buttons, not placeholder text',
      '   - InfoPoints must use React.createElement(InfoPoint, { label, explanation, position, color })',
      '',
      '4. BEST PRACTICES:',
      '   - All meshes/geometries must have proper material and geometry children',
      '   - useFrame callback must not create new objects every frame (use refs)',
      '   - runtimeState.params should be read at the top of Scene, not inside nested functions',
    ].join('\n')

    const maxReviewRounds = 5
    let reviewRound = 0
    let prevReviewContext: ResponseInputItem[] = []

    while (reviewRound < maxReviewRounds) {
      reviewRound++

      const reviewInput: ResponseInputItem[] = [
        {
          role: 'user',
          content: [
            'Review and fix this visualization code.',
            '',
            '=== CHECKLIST (what should be implemented) ===',
            formatChecklist(checklist),
            '=== END CHECKLIST ===',
            '',
            '=== CODE ===',
            addLineNumbers(state.currentCode),
            '=== END CODE ===',
            '',
            referenceBlock,
            '',
            `User request: ${args.userPrompt}`,
            '',
            'Fix all bugs and fill in any missing implementations. Use str_replace for all fixes.',
            'If the code is correct, make no tool calls.',
          ].join('\n'),
        },
      ]

      if (prevReviewContext.length > 0) {
        reviewInput.push(...prevReviewContext)
        reviewInput.push({
          role: 'user',
          content: 'The code above reflects your previous fixes. Continue reviewing — make more fixes if needed, or make no tool calls if done.',
        })
      }

      const reviewResponse = await args.openaiClient.responses.create({
        model: 'gpt-5.3-codex',
        instructions: reviewInstructions,
        input: reviewInput,
        tools: editTools,
      })

      const reviewCalls = reviewResponse.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      if (reviewCalls.length === 0) {
        console.log(`[generateCode] reviewer done after ${reviewRound} rounds — no more fixes`)
        break
      }

      console.log(`[generateCode] reviewer round ${reviewRound}: ${reviewCalls.length} fixes`)
      const roundContext: ResponseInputItem[] = [...(reviewResponse.output as ResponseInputItem[])]

      for (const fc of reviewCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const result = executeEditTool(fc.name, toolArgs, state)
        console.log(`[generateCode] review fix ${fc.name}: ${result.success ? 'ok' : result.error}`)

        roundContext.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output: JSON.stringify(result),
        })
      }

      prevReviewContext = roundContext
    }

    // ---------- Phase 3: Validation + repair ----------
    for (let attempt = 1; attempt <= maxValidationAttempts; attempt++) {
      const validation = validateGeneratedSceneCode(state.currentCode, args.renderType)
      if (validation.ok) {
        console.log('[generateCode] ✓ validation passed')
        break
      }

      console.log(`[generateCode] validation failed (attempt ${attempt}): ${validation.error.message}`)

      if (attempt === maxValidationAttempts) {
        console.warn('[generateCode] validation failed after all repair attempts')
        return { ok: false, error: validation.error }
      }

      // Ask model to fix validation errors
      const fixInput: ResponseInputItem[] = [
        {
          role: 'user',
          content: [
            'The code has a validation error. Fix it.',
            '',
            `Error: ${validation.error.phase}: ${validation.error.message}`,
            '',
            '=== CURRENT CODE ===',
            addLineNumbers(state.currentCode),
            '=== END CURRENT CODE ===',
            '',
            referenceBlock,
            '',
            'Fix the error using str_replace or insert.',
          ].join('\n'),
        },
      ]

      const fixResponse = await args.openaiClient.responses.create({
        model: 'gpt-5.3-codex',
        instructions,
        input: fixInput,
        tools: editTools,
      })

      const fixCalls = fixResponse.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      for (const fc of fixCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const result = executeEditTool(fc.name, toolArgs, state)
        console.log(`[generateCode] fix ${fc.name}: ${result.success ? 'ok' : result.error}`)
      }
    }
  } catch (error) {
    console.error('[generateCode] agent run failed', error)
  }

  // Final safety validation
  const finalValidation = validateGeneratedSceneCode(state.currentCode, args.renderType)
  if (!finalValidation.ok) {
    console.warn('[generateCode] final code failed validation', finalValidation.error)
    return { ok: false, error: finalValidation.error }
  }

  const completed = checklist.filter((i) => i.done).length
  console.log(`[generateCode] finished: ${completed}/${checklist.length} items completed`)

  return { ok: true, code: state.currentCode, checklist }
}
