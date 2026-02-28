import { generateObject } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { RenderType } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'

const editCodeSchema = z
  .object({
    edits: z.array(
      z.object({
        find: z.string().describe('The exact substring to find in the current code'),
        replace: z.string().describe('The string to replace it with'),
      }),
    ),
  })
  .strict()

/** Apply find-and-replace edits sequentially. Returns the patched code or an error. */
function applyEdits(
  code: string,
  edits: Array<{ find: string; replace: string }>,
): { ok: true; code: string } | { ok: false; error: string } {
  let patched = code

  for (let i = 0; i < edits.length; i++) {
    const { find, replace } = edits[i]

    if (!patched.includes(find)) {
      return {
        ok: false,
        error: `Edit ${i + 1}: could not find the substring to replace. Make sure "find" is an exact match of existing code.`,
      }
    }

    patched = patched.replace(find, replace)
  }

  return { ok: true, code: patched }
}

function buildEditPrompt(args: {
  currentCode: string
  instruction: string
  renderType: RenderType
  previousError?: string
}): string {
  const { currentCode, instruction, renderType, previousError } = args
  const lines = [
    'You are editing existing visualization code for MindCanvas using find-and-replace.',
    '',
    'Current code:',
    '```',
    currentCode,
    '```',
    '',
    `User's edit request: ${instruction}`,
    `Render type: ${renderType}`,
    '',
    'Rules:',
    '- Return an array of { find, replace } edits.',
    '- "find" must be an EXACT substring of the current code (whitespace-sensitive).',
    '- "replace" is what that substring should become.',
    '- Make the minimum edits needed. Do NOT rewrite code that does not need to change.',
    '- Edits are applied sequentially, so later edits see the result of earlier ones.',
  ]

  lines.push(...getRenderTypeRules(renderType))

  if (previousError) {
    lines.push(
      '',
      'Your previous edit attempt failed:',
      previousError,
      'Fix the issue. Make sure "find" strings are exact substrings of the current code.',
    )
  }

  return lines.join('\n')
}

export async function editVisualizationCode(args: {
  openai: ReturnType<typeof createOpenAI>
  currentCode: string
  renderType: RenderType
  instruction: string
  maxAttempts?: number
}): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const maxAttempts = args.maxAttempts ?? 3
  let previousError: string | undefined
  // Track the current code state — if a previous attempt partially succeeded
  // but failed validation, retry against the patched version.
  let currentCode = args.currentCode

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { object } = await generateObject({
        model: args.openai.responses('gpt-5.3-codex'),
        schema: editCodeSchema,
        schemaName: 'mindcanvas_edit_code',
        prompt: buildEditPrompt({
          currentCode,
          instruction: args.instruction,
          renderType: args.renderType,
          previousError,
        }),
      })

      console.log('[editVisualizationCode] edits', {
        attempt,
        edits: JSON.stringify(object, null, 2),
      })

      // Apply the find-and-replace edits
      const patchResult = applyEdits(currentCode, object.edits)
      if (!patchResult.ok) {
        previousError = patchResult.error
        console.error('[editVisualizationCode] patch failed', {
          attempt,
          error: previousError,
        })
        continue
      }

      // Validate the patched code
      const validation = validateGeneratedSceneCode(
        patchResult.code,
        args.renderType,
      )

      if (validation.ok) {
        console.log('[editVisualizationCode] success', { attempt })
        return { ok: true, code: patchResult.code }
      }

      // Validation failed — update currentCode to the patched version so the
      // next attempt can fix the validation issue on top of the applied changes.
      currentCode = patchResult.code
      previousError = `Validation failed: ${validation.error.message}${
        validation.error.details ? ` (${validation.error.details.join(', ')})` : ''
      }`
      console.error('[editVisualizationCode] validation failed', {
        attempt,
        error: previousError,
      })
    } catch (error) {
      previousError =
        error instanceof Error ? error.message : 'Code generation failed'
      console.error('[editVisualizationCode] generation failed', {
        attempt,
        error,
      })
    }
  }

  return {
    ok: false,
    error: `Failed to edit visualization code after ${maxAttempts} attempts. Last error: ${previousError}`,
  }
}
