import type { AgentSSEEvent } from '../../types/agent'

export function createSSEStream(
  producer: (emit: (event: AgentSSEEvent) => void) => Promise<void>,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: AgentSSEEvent) => {
        controller.enqueue(
          encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`),
        )
      }

      void producer(emit)
        .catch((error) => {
          emit({
            type: 'error',
            message: error instanceof Error ? error.message : 'Unknown agent error',
          })
        })
        .finally(() => {
          emit({ type: 'done' })
          controller.close()
        })
    },
  })
}

export function chunkText(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length <= 12) return [text]

  const chunks: string[] = []
  for (let i = 0; i < words.length; i += 8) {
    chunks.push(words.slice(i, i + 8).join(' '))
  }
  return chunks
}
