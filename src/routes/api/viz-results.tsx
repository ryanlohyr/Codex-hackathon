import { createFileRoute } from '@tanstack/react-router'
import { popVisualizations } from '~/server/handlers/viz-store'

export const Route = createFileRoute('/api/viz-results')({
    server: {
        handlers: {
            GET: async () => {
                const configs = popVisualizations()
                return new Response(
                    JSON.stringify({ configs }),
                    { headers: { 'Content-Type': 'application/json' } },
                )
            },
        },
    },
} as any)
