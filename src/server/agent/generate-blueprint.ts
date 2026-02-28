import { generateObject } from 'ai'
import { z } from 'zod'
import type { createOpenAI } from '@ai-sdk/openai'
import type { AgentContext } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import type { ChecklistItem } from './create-visualization-with-repair'
import { BLUEPRINT_SYSTEM_PROMPT, getRenderTypeRules } from './prompts'
import { SCENE_BOILERPLATES } from './webgl-boilerplates'

const MAX_RETRIES = 5

const blueprintWithChecklistSchema = z
  .object({
    blueprint: z
      .string()
      .describe(
        'The full Visualization Blueprint as a markdown document — includes Visual Style, Learning Goal, Analogy, Visual Concept, Simulation Variables, Info Points, and Scaffolding Steps sections.',
      ),
    boilerplateKey: z
      .string()
      .nullable()
      .describe(
        'If an available boilerplate template fits this visualization, set this to its key (e.g. "webgl_3d_real_globe_v1"). Set to null if no template is a good fit.',
      ),
    checklist: z.array(
      z
        .object({
          id: z
            .string()
            .describe('Short snake_case identifier (e.g. "scene_setup", "controls_panel").'),
          description: z
            .string()
            .describe(
              'Detailed implementation instructions for this task — include exact variable names, position coordinates, hex colors, and interaction details.',
            ),
        })
        .strict(),
    ),
  })
  .strict()

export async function generateBlueprint(args: {
  openai: ReturnType<typeof createOpenAI>
  userPrompt: string
  context: AgentContext
  renderType: RenderType
  abortSignal?: AbortSignal
}): Promise<
  { ok: true; blueprint: string; checklist: ChecklistItem[]; boilerplateKey: string | null } | { ok: false; error: string }
> {
  console.log('[generateBlueprint] starting', {
    renderType: args.renderType,
    prompt: args.userPrompt,
  })

  const userPrompt = `Student's request: ${args.userPrompt}`
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  let attempt = 0
  let lastError = ''

  while (attempt < MAX_RETRIES) {
    if (args.abortSignal?.aborted) {
      console.log('[generateBlueprint] ⚡ Aborted before attempt', attempt + 1)
      return { ok: false, error: 'Generation aborted by user.' }
    }

    attempt++
    console.log(`[generateBlueprint] attempt ${attempt}/${MAX_RETRIES}`)

    try {
      const { object } = await generateObject({
        model: args.openai.responses('gpt-5.2'),
        schema: blueprintWithChecklistSchema,
        schemaName: 'mindcanvas_blueprint_and_checklist',
        system: [
          BLUEPRINT_SYSTEM_PROMPT,
          '',
          '---',
          '',
          'In addition to the blueprint, you must ALSO produce an implementation checklist.',
          'You are a senior engineer breaking down the visualization into an ordered implementation plan.',
          'Each checklist item must be a self-contained task that a code-generation agent can implement by writing actual code.',
          'Write each description as if you are giving instructions to a junior developer — be explicit about:',
          '  - Which API calls to use (React.createElement, helpers.ScreenOverlay, helpers.InfoPoint, helpers.useFrame, etc.)',
          '  - Exact variable names, hex colors from the palette, position coordinates [x,y,z], numeric ranges (min/max/default)',
          '  - What the rendered output should look like (e.g. "a blue sphere at [0,2,0] with radius 0.3")',
          '  - How state flows (e.g. "read cPenalty from runtimeState.params, use it to compute margin width")',
          '',
          'ORDER checklist items like a senior engineer would build this:',
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
          '=== AVAILABLE BOILERPLATE TEMPLATES ===',
          'If a template below is a good starting point for this visualization, set boilerplateKey to its key. Otherwise set boilerplateKey to null.',
          ...SCENE_BOILERPLATES.filter((b) => b.renderType === args.renderType).map(
            (b) => `- key: "${b.key}" — ${b.name}. Use for: ${b.whenToUse}`,
          ),
          ...(SCENE_BOILERPLATES.filter((b) => b.renderType === args.renderType).length === 0
            ? ['No boilerplate templates available for this render type.']
            : []),
          '=== END AVAILABLE BOILERPLATE TEMPLATES ===',
          '',
          `Render type: ${args.renderType}`,
          '',
          '=== RENDERING ENGINE RULES ===',
          renderRules,
          '=== END RENDERING ENGINE RULES ===',
        ].join('\n'),
        prompt: userPrompt,
        providerOptions: {
          openai: {
            reasoningEffort: 'low',
          },
        },
        abortSignal: args.abortSignal,
      })

      if (!object.blueprint || object.blueprint.trim().length === 0) {
        lastError = 'Blueprint generation returned an empty blueprint'
        console.warn(`[generateBlueprint] attempt ${attempt} failed: empty blueprint`)
        continue
      }

      if (!object.checklist || object.checklist.length === 0) {
        lastError = 'Blueprint generation returned an empty checklist'
        console.warn(`[generateBlueprint] attempt ${attempt} failed: empty checklist`)
        continue
      }

      const checklist: ChecklistItem[] = object.checklist.map((item) => ({
        id: item.id,
        description: item.description,
        done: false,
      }))

      console.log('[generateBlueprint] success', {
        prompt: args.userPrompt,
        attempt,
        blueprintLength: object.blueprint.length,
        checklistItems: checklist.map((i) => i.id),
      })

      return { ok: true, blueprint: object.blueprint, checklist, boilerplateKey: object.boilerplateKey ?? null }
    } catch (error) {
      if (args.abortSignal?.aborted || (error as DOMException).name === 'AbortError') {
        console.log('[generateBlueprint] ⚡ Aborted during generateText HTTP call')
        return { ok: false, error: 'Generation aborted by user.' }
      }
      lastError = error instanceof Error ? error.message : 'Blueprint generation failed'
      console.error(`[generateBlueprint] attempt ${attempt} failed`, error)
    }
  }

  console.error(`[generateBlueprint] all ${MAX_RETRIES} attempts exhausted`)
  return { ok: false, error: lastError }
}
