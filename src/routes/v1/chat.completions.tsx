import { createFileRoute } from '@tanstack/react-router'
import { handleCustomLLMRequest } from '~/server/handlers/custom-llm-handler'

export const Route = createFileRoute('/v1/chat/completions')({
    server: {
        handlers: {
            POST: async ({ request }: any) => {
                return handleCustomLLMRequest(request)
            },
        },
    },
} as any)
