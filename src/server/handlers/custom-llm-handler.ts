import { createOpenAI } from '@ai-sdk/openai'
import { runGraphFlow } from '~/server/agent/run-graph-flow'
import type { AgentSSEEvent, AgentStreamRequest } from '~/types/agent'
import type { VisualizationRuntimeState } from '~/types/visualization'
import { pushVisualization } from './viz-store'

// Track prompt keys that are currently being generated in the background
// Used only to prevent duplicate background tasks — NOT for hold messages
const activeGenerations = new Set<string>()

/** Build a minimal SSE response with a single spoken message then [DONE] */
function sseAck(text: string): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        start(controller) {
            const chunk = { choices: [{ delta: { content: text }, index: 0, finish_reason: null }] }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
            const done = { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
        },
    })
    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
}

/** Build a minimal SSE response with just [DONE] — silently closes the turn */
function sseEmpty(): Response {
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        start(controller) {
            const done = { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`))
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
            controller.close()
        },
    })
    return new Response(stream, {
        headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    })
}

export async function handleCustomLLMRequest(request: Request): Promise<Response> {
    console.log('[CustomLLM] ═══ NEW REQUEST ═══')
    console.log('[CustomLLM] Method:', request.method)
    console.log('[CustomLLM] URL:', request.url)
    console.log('[CustomLLM] Origin:', request.headers.get('origin') || 'unknown')

    const body = await request.json()
    console.log('[CustomLLM] Body received with keys:', Object.keys(body))

    // ── Extract the last user message from OpenAI-style messages ──
    const messages: Array<{ role: string; content: string }> = body.messages ?? []
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    const userPrompt = lastUserMessage?.content ?? ''

    console.log(`[CustomLLM] Messages count: ${messages.length}`)
    console.log(`[CustomLLM] User prompt: "${userPrompt.slice(0, 100)}"`)

    // ── Reject garbage/empty prompts (e.g. "......" from ElevenLabs silence) ──
    const cleanedPrompt = userPrompt.replace(/[.\s…]+/g, '').trim()
    if (!userPrompt || cleanedPrompt.length < 2) {
        console.log(`[CustomLLM] ⚡ Rejecting garbage prompt: "${userPrompt.slice(0, 30)}"`)
        return sseEmpty()
    }

    // ── VIZ_READY gate: frontend signals viz is done, speak confirmation without running graph ──
    if (userPrompt.includes('[VIZ_READY]')) {
        console.log('[CustomLLM] ⚡ VIZ_READY gate — returning spoken confirmation')
        return sseAck('Your visualization is ready! You can explore it on the canvas now.')
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        console.log('[CustomLLM] ✗ OPENAI_API_KEY missing, returning 500')
        return new Response(
            JSON.stringify({ error: 'OPENAI_API_KEY is missing' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
    }

    // ── Deduplication: if already running this prompt in background, ignore silently ──
    const promptKey = userPrompt.trim().toLowerCase().slice(0, 200)
    if (activeGenerations.has(promptKey)) {
        console.log(`[CustomLLM] ⚡ Already generating for "${promptKey.slice(0, 50)}" — ignoring retry`)
        // Close silently — ElevenLabs will go to listening mode, no hold message spam
        return sseEmpty()
    }

    const openai = createOpenAI({ apiKey })

    const emptyRuntimeState: VisualizationRuntimeState = {
        params: {},
        toggles: {},
        cues: [],
    }

    const agentRequest: AgentStreamRequest = {
        prompt: userPrompt,
        context: {
            activeVisualizationId: null,
            activeVisualizationConfig: null,
            activeRuntimeState: emptyRuntimeState,
            recentMessages: messages
                .filter((m) => m.role === 'user' || m.role === 'assistant')
                .map((m) => ({
                    role: m.role as 'user' | 'assistant',
                    content: m.content,
                })),
        },
        routeContext: { route: 'graph' as const },
    }

    // ── Fire-and-Forget: run generation in background, respond immediately ──
    // This is the key architectural change:
    // - We do NOT await runGraphFlow before responding.
    // - ElevenLabs gets an ack in <100ms and the turn closes cleanly.
    // - No more 10s timeouts → no more "......" retries → no hold messages.
    // - Results (visualizations) are pushed to viz-store, frontend polls for them.
    activeGenerations.add(promptKey)

    // Kick off the generation without awaiting
    void runGenerationInBackground(openai, agentRequest, promptKey)

    // Respond IMMEDIATELY with a short spoken ack
    console.log('[CustomLLM] ⚡ Fire-and-forget: responding immediately, generation running in background')
    return sseAck("Got it! I'm working on that now. Check the canvas in a moment.")
}

/** Runs the full LLM pipeline in the background, stores any visualizations in viz-store */
async function runGenerationInBackground(
    openai: ReturnType<typeof createOpenAI>,
    agentRequest: AgentStreamRequest,
    promptKey: string,
): Promise<void> {
    console.log(`[CustomLLM] 🔄 Background generation started for: "${promptKey.slice(0, 50)}"`)

    const emit = (event: AgentSSEEvent) => {
        switch (event.type) {
            case 'tool_call':
                console.log(`[CustomLLM] ← [background] tool_call: ${event.toolName}`)
                break
            case 'final':
                console.log(`[CustomLLM] ← [background] final: ${event.actions.length} actions`)
                break
            case 'error':
                console.log(`[CustomLLM] ← [background] error: ${event.message}`)
                break
        }
    }

    try {
        const flowResult = await runGraphFlow({ openai, request: agentRequest, emit })
        console.log(`[CustomLLM] ✓ Background generation complete. actions=${flowResult.actions.length}`)

        let hasVisualizations = false
        for (const action of flowResult.actions) {
            if (action.type === 'create_visualization' && action.config) {
                pushVisualization(action.config)
                hasVisualizations = true
                console.log(`[CustomLLM] ✓ Pushed visualization to store: "${action.config.title}"`)
            }
        }

        if (!hasVisualizations) {
            // For non-viz responses: store the text as a pending message so frontend can display it
            // (The frontend polls /api/viz-results, so text-only responses just won't appear in transcript)
            // This is acceptable for a demo — all voice interactions lead to visualizations
            console.log(`[CustomLLM] ℹ No visualizations in this response: "${flowResult.assistantMessage.slice(0, 80)}"`)
        }
    } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        console.log(`[CustomLLM] ✗ Background generation ERROR: ${errorMsg}`)
    } finally {
        activeGenerations.delete(promptKey)
        console.log(`[CustomLLM] 🏁 Background generation finished for: "${promptKey.slice(0, 50)}"`)
    }
}
