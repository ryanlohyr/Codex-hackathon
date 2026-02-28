import type { createOpenAI } from '@ai-sdk/openai'
import { streamText } from 'ai'
import { vizTools, parseToolCall } from './viz-tools'
import { editVisualizationCode } from './edit-visualization-code'
import { EDIT_AGENT_SYSTEM_PROMPT } from './prompts'
import type { AgentAction, AgentSSEEvent, AgentStreamRequest } from '../../types/agent'

export async function runVizFlow(args: {
  openai: ReturnType<typeof createOpenAI>
  request: AgentStreamRequest
  emit: (event: AgentSSEEvent) => void
}): Promise<{ assistantMessage: string; actions: AgentAction[]; messageStreamed: boolean }> {
  const { openai, request, emit } = args

  const result = streamText({
    model: openai.responses('gpt-5.2'),
    system: EDIT_AGENT_SYSTEM_PROMPT,
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
    tools: vizTools,
  })

  let assistantMessage = ''
  for await (const delta of result.textStream) {
    assistantMessage += delta
    emit({ type: 'text_delta', delta })
  }

  // Process tool calls — handle edit_code via sub-agent, others as runtime commands
  const toolCallResults = await result.toolCalls
  const actions: AgentAction[] = []

  for (const tc of toolCallResults) {
    if (tc.toolName === 'edit_code') {
      const editArgs = tc.input as { instruction: string }
      const activeConfig = request.context.activeVisualizationConfig
      const currentCode = activeConfig?.generatedSceneCode

      if (!currentCode || !request.context.activeVisualizationId) {
        emit({
          type: 'text_delta',
          delta: '\n\nNo active visualization code to edit.',
        })
        assistantMessage += '\n\nNo active visualization code to edit.'
        continue
      }

      emit({ type: 'text_delta', delta: '\n\nEditing visualization...' })
      assistantMessage += '\n\nEditing visualization...'

      const editResult = await editVisualizationCode({
        openai,
        currentCode,
        renderType: activeConfig.renderType ?? '3D_WEBGL',
        instruction: editArgs.instruction,
      })

      if (editResult.ok) {
        actions.push({
          type: 'update_visualization_code',
          visualizationId: request.context.activeVisualizationId,
          code: editResult.code,
        })
        emit({ type: 'text_delta', delta: ' Done!' })
        assistantMessage += ' Done!'
      } else {
        emit({
          type: 'text_delta',
          delta: ` Failed: ${editResult.error}`,
        })
        assistantMessage += ` Failed: ${editResult.error}`
      }
    } else {
      const command = parseToolCall(tc.toolName, tc.input as Record<string, unknown>)
      if (command) {
        actions.push({ type: 'apply_command', command })
      }
    }
  }

  return {
    assistantMessage: assistantMessage.trim() || 'Done.',
    actions,
    messageStreamed: true,
  }
}
