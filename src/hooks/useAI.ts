import { askAgentStream } from '../server/ask-agent'
import type { AgentContext, AgentSSEEvent, AgentStreamRequest } from '../types/agent'

export function useAI() {
  const consumeFrame = (
    frame: string,
    onEvent: (event: AgentSSEEvent) => void,
  ) => {
    const normalized = frame.replace(/\r\n/g, '\n')
    const dataPayload = normalized
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')

    if (!dataPayload) return

    try {
      onEvent(JSON.parse(dataPayload) as AgentSSEEvent)
    } catch (error) {
      console.warn('[useAI] Failed to parse stream frame', { dataPayload, error })
    }
  }

  async function streamPrompt(args: {
    prompt: string
    context: AgentContext
    routeContext: AgentStreamRequest['routeContext']
    onEvent: (event: AgentSSEEvent) => void
  }) {
    const stream = await askAgentStream({
      data: {
        prompt: args.prompt,
        context: args.context,
        routeContext: args.routeContext,
      },
    })

    if (!(stream instanceof ReadableStream)) {
      throw new Error('Agent stream did not return a ReadableStream')
    }

    const decoder = new TextDecoder()
    const reader = stream.getReader()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n')
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''

      for (const frame of frames) {
        consumeFrame(frame, args.onEvent)
      }
    }

    if (buffer.trim().length > 0) {
      consumeFrame(buffer, args.onEvent)
    }
  }

  return { streamPrompt }
}
