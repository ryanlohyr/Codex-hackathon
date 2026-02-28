import { createOpenAI } from '@ai-sdk/openai'
import { createServerFn } from '@tanstack/react-start'
import { createSSEStream, chunkText } from './agent/sse-stream'
import { runGraphFlow } from './agent/run-graph-flow'
import { runVizFlow } from './agent/run-viz-flow'
import type { AgentStreamRequest } from '../types/agent'

export const askAgentStream = createServerFn({ method: 'POST' })
  .inputValidator((data) => data as AgentStreamRequest)
  .handler(async ({ data }) => {
    const apiKey = process.env.OPENAI_API_KEY

    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing')
    }

    const openai = createOpenAI({ apiKey })
    return createSSEStream(async (emit) => {
      const flowResult =
        data.routeContext.route === 'graph'
          ? await runGraphFlow({ openai, request: data, emit })
          : await runVizFlow({ openai, request: data, emit })

      if (!flowResult.messageStreamed) {
        for (const delta of chunkText(flowResult.assistantMessage)) {
          emit({ type: 'text_delta', delta: `${delta} ` })
        }
      }

      emit({
        type: 'final',
        assistantMessage: flowResult.assistantMessage,
        actions: flowResult.actions,
      })
    })
  })
