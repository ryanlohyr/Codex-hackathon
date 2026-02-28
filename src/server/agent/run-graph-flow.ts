import type { createOpenAI } from '@ai-sdk/openai'
import OpenAI from 'openai'
import { streamText, tool } from 'ai'
import { z } from 'zod'
import { generateVisualizationMetadata } from './create-visualization-with-repair'
import { generateBlueprint } from './generate-blueprint'
import { generateVisualizationCodeV5 } from './create-visualization-with-repair-v5'
import { classifyRenderType } from './classify-render-type'
import { CHAT_ONLY_SYSTEM_PROMPT } from './prompts'
import type { AgentAction, AgentSSEEvent, AgentStreamRequest } from '../../types/agent'
import type { VisualizationConfig } from '../../types/visualization'

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) {
    console.log('[runGraphFlow] ⚡ Abort detected — stopping early')
    throw new DOMException('Aborted', 'AbortError')
  }
}

export async function runGraphFlow(args: {
  openai: ReturnType<typeof createOpenAI>
  request: AgentStreamRequest
  emit: (event: AgentSSEEvent) => void
  abortSignal?: AbortSignal
}): Promise<{ assistantMessage: string; actions: AgentAction[]; messageStreamed: boolean }> {
  const { openai, request, emit, abortSignal } = args

  console.log('[runGraphFlow] request:', JSON.stringify(request, null, 2))
  const result = streamText({
    model: openai.responses('gpt-5.2'),
    system: `${CHAT_ONLY_SYSTEM_PROMPT}

If the user asks to create/build/generate a new visualization, ask exactly ONE brief clarifying question before calling the create_visualization tool. Keep it short and direct. Once the user answers, immediately call the tool — do not ask any more questions.
If the user is only asking a question, answer conversationally without tools.`,
    messages: [
      ...request.context.recentMessages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
      })),
      // Always include the current prompt as the final user message
      // (handles case where recentMessages is empty or doesn't include it yet)
      ...(request.context.recentMessages.some((m) => m.role === 'user' && m.content === request.prompt)
        ? []
        : [{ role: 'user' as const, content: request.prompt }]),
    ],
    providerOptions: {
      openai: {
        reasoningEffort: 'low',
      },
    },
    abortSignal,
    tools: {
      create_visualization: tool({
        description: 'Create a new visualization from the user prompt. Only describe the subject/concept — never specify the rendering medium (2D, 3D, etc.).',
        inputSchema: z.object({
          prompt: z.string().describe('What the user wants to visualize (subject, concept, or data). Do NOT include rendering medium like "3D", "2D", "WebGL", or "canvas".'),
        }),
      }),
    },
  })

  let assistantMessage = ''
  for await (const delta of result.textStream) {
    checkAbort(abortSignal)
    assistantMessage += delta
    emit({ type: 'text_delta', delta })
  }

  checkAbort(abortSignal)
  const toolCallResults = await result.toolCalls
  const actions: AgentAction[] = []

  for (const tc of toolCallResults) {
    if (tc.toolName !== 'create_visualization') {
      continue
    }

    const toolArgs = tc.input as { prompt?: string }
    const toolPrompt = toolArgs.prompt?.trim() || request.prompt
    const callId = `tool-${Date.now()}`

    // Step 1: Classify render type so the blueprint can target the correct mode
    checkAbort(abortSignal)
    const renderType = await classifyRenderType({ openai, prompt: toolPrompt })
    const startTime = Date.now()

    // Step 2: Generate combined blueprint + checklist in a single call
    const blueprintResult = await generateBlueprint({
      openai,
      userPrompt: toolPrompt,
      context: request.context,
      renderType,
    })

    console.log(`[runGraphFlow] blueprint generation time: ${Date.now() - startTime}ms`)

    if (!blueprintResult.ok) {
      console.warn('[runGraphFlow] blueprint generation failed', blueprintResult.error)
      emit({
        type: 'tool_error',
        callId,
        error: {
          attempts: [],
          finalError: { phase: 'schema', message: 'Blueprint generation failed.' },
          suggestions: ['Try rephrasing your request.'],
        },
      })
      assistantMessage =
        assistantMessage.trim() || 'Blueprint generation failed. Please try rephrasing your request.'
      continue
    }

    const { blueprint, checklist, boilerplateKey } = blueprintResult
    emit({ type: 'blueprint_ready', callId, blueprint })

    emit({
      type: 'tool_call',
      toolName: 'create_visualization',
      callId,
      args: { prompt: toolPrompt },
    })

    console.log('blueprint generated', blueprint)
    console.log('checklist generated', checklist)

    // Steps 3 & 4: Generate metadata and visualization code in parallel
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const [metadata, codeResult] = await Promise.all([
      generateVisualizationMetadata({ openai, blueprint, userPrompt: toolPrompt }),
      generateVisualizationCodeV5({
        openaiClient,
        blueprint,
        checklist,
        renderType,
        userPrompt: toolPrompt,
        runtimePanels: true,
        boilerplateKey,
      }),
    ])

    console.log(`[runGraphFlow] visualization code generation time: ${Date.now() - startTime}ms`)

    if (codeResult.ok) {
      const config: VisualizationConfig = {
        type: metadata.type,
        renderType,
        theme: metadata.theme,
        title: `"${metadata.title}-${Date.now()}"`,
        summary: metadata.summary,
        params: metadata.params,
        generatedSceneCode: codeResult.code,
        blueprint,
        controls: metadata.controls,
        scaffoldedSteps: metadata.scaffoldedSteps,
      }

      emit({
        type: 'tool_result',
        callId,
        result: { config, attempts: [] },
      })

      console.log(`[runGraphFlow] visualization done — callId: ${callId}, title: ${config.title}`)

      actions.push({ type: 'create_visualization', config })
      assistantMessage = assistantMessage.trim() || `Created visualization: ${config.title}.`
      continue
    }

    emit({
      type: 'tool_error',
      callId,
      error: {
        attempts: [],
        finalError: codeResult.error,
        suggestions: ['Try a simpler visualization or rephrase your request.'],
      },
    })

    assistantMessage =
      assistantMessage.trim() ||
      `Visualization code generation failed: ${codeResult.error.message}`
  }

  return {
    assistantMessage: assistantMessage.trim() || 'How can I help with your MindCanvas graph?',
    actions,
    messageStreamed: true,
  }
}
