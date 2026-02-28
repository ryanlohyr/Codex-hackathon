import type { createOpenAI } from '@ai-sdk/openai'
import OpenAI from 'openai'
import { streamText, tool } from 'ai'
import fs from 'fs'
import { z } from 'zod'
import { generateChecklist, generateVisualizationMetadata } from './create-visualization-with-repair'
import { generateVisualizationCodeV4 } from './create-visualization-with-repair-v4'
import { generateVisualizationCodeV5 } from './create-visualization-with-repair-v5'
import { generateBlueprint } from './generate-blueprint'
import { classifyRenderType } from './classify-render-type'
import { CHAT_ONLY_SYSTEM_PROMPT } from './prompts'
import type { AgentAction, AgentSSEEvent, AgentStreamRequest } from '../../types/agent'
import type { VisualizationConfig } from '../../types/visualization'
import fs from 'fs'


export async function runGraphFlow(args: {
  openai: ReturnType<typeof createOpenAI>
  request: AgentStreamRequest
  emit: (event: AgentSSEEvent) => void
}): Promise<{ assistantMessage: string; actions: AgentAction[]; messageStreamed: boolean }> {
  const { openai, request, emit } = args

  const result = streamText({
    model: openai.responses('gpt-5.2'),
    system: `${CHAT_ONLY_SYSTEM_PROMPT}

If the user asks to create/build/generate a new visualization, call the create_visualization tool.
If the user is only asking a question, answer conversationally without tools.`,
    messages: [
      {
        role: 'user',
        content: `User prompt: ${request.prompt}\n\nContext:\n${JSON.stringify(request.context)}`,
      },
    ],
    providerOptions: {
      openai: {
        reasoningEffort: 'medium',
      },
    },
    tools: {
      create_visualization: tool({
        description: 'Create a new visualization from the user prompt. Only describe the subject/concept — never specify the rendering medium (2D, 3D, etc.).',
        inputSchema: z.object({
          prompt: z.string().describe('What the user wants to visualize (subject, concept, or data). Do NOT include rendering medium like "3D", "2D", "WebGL", or "canvas".'),
        }),
      }),
    },  })

  let assistantMessage = ''
  for await (const delta of result.textStream) {
    assistantMessage += delta
    emit({ type: 'text_delta', delta })
  }

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
    const renderType = await classifyRenderType({ openai, prompt: toolPrompt })

    // // // Step 2: Generate combined blueprint (educational design + technical plan + render rules)
    // const blueprintResult = await generateBlueprint({
    //   openai,
    //   userPrompt: toolPrompt,
    //   context: request.context,
    //   renderType,
    // })

    // if (!blueprintResult.ok) {
    //   console.warn('[runGraphFlow] blueprint generation failed', blueprintResult.error)
    //   emit({
    //     type: 'tool_error',
    //     callId,
    //     error: {
    //       attempts: [],
    //       finalError: { phase: 'schema', message: 'Blueprint generation failed.' },
    //       suggestions: ['Try rephrasing your request.'],
    //     },
    //   })
    //   assistantMessage =
    //     assistantMessage.trim() || 'Blueprint generation failed. Please try rephrasing your request.'
    //   continue
    // }

    // const blueprint = blueprintResult.blueprint
    // emit({ type: 'blueprint_ready', callId, blueprint })

    // emit({
    //   type: 'tool_call',
    //   toolName: 'create_visualization',
    //   callId,
    //   args: { prompt: toolPrompt },
    // })

    // // Step 3: Generate checklist + metadata in parallel from the blueprint
    // const [checklist, metadata] = await Promise.all([
    //   generateChecklist({ openai, blueprint, renderType }),
    //   generateVisualizationMetadata({ openai, blueprint, userPrompt: toolPrompt }),
    // ])

    const blueprint = fs.readFileSync('blueprint.txt', 'utf8')
    const checklist = JSON.parse(fs.readFileSync('checklist.json', 'utf8'))
    const metadata = JSON.parse(fs.readFileSync('metadata.json', 'utf8'))

    // fs.writeFileSync('checklist.json', JSON.stringify(checklist, null, 2))
    // fs.writeFileSync('blueprint.txt', blueprint)
    // fs.writeFileSync('metadata.json', JSON.stringify(metadata, null, 2))

    // Step 4: Generate visualization code iteratively using the checklist
    const openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    const codeResult = await generateVisualizationCodeV5({
      openaiClient,
      blueprint,
      checklist,
      renderType,
      userPrompt: toolPrompt,
      runtimePanels: true,
    })

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
