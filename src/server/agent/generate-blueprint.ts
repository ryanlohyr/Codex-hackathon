import { generateText } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
import type { AgentContext } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import { BLUEPRINT_SYSTEM_PROMPT } from './prompts'

const MAX_RETRIES = 5

export async function generateBlueprint(args: {
  openai: ReturnType<typeof createOpenAI>
  userPrompt: string
  context: AgentContext
  renderType: RenderType
}): Promise<{ ok: true; blueprint: string } | { ok: false; error: string }> {
  console.log('[generateBlueprint] starting', {
    renderType: args.renderType,
    prompt: args.userPrompt,
  })

  const userPrompt = `Student's request: ${args.userPrompt}`

  let attempt = 0
  let lastError = ''

  while (attempt < MAX_RETRIES) {
    attempt++
    console.log(`[generateBlueprint] attempt ${attempt}/${MAX_RETRIES}`)

    try {
      const { text } = await generateText({
        model: args.openai.responses('gpt-5.2'),
        system: BLUEPRINT_SYSTEM_PROMPT,
        prompt: userPrompt,
      })

      if (!text || text.trim().length === 0) {
        lastError = 'Blueprint generation returned an empty response'
        console.warn(`[generateBlueprint] attempt ${attempt} failed: empty response`)
        continue
      }

      console.log('[generateBlueprint] success', {
        prompt: args.userPrompt,
        attempt,
        blueprintLength: text,
      })

      return { ok: true, blueprint: text }
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Blueprint generation failed'
      console.error(`[generateBlueprint] attempt ${attempt} failed`, error)
    }
  }

  console.error(`[generateBlueprint] all ${MAX_RETRIES} attempts exhausted`)
  return { ok: false, error: lastError }
}
