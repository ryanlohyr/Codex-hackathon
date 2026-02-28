import { createOpenAI } from '@ai-sdk/openai'
import { runGraphFlow } from '~/server/agent/run-graph-flow'
import type { AgentSSEEvent, AgentStreamRequest, AgentAction } from '~/types/agent'
import type { VisualizationRuntimeState } from '~/types/visualization'
import { pushVisualization } from './viz-store'

// In-memory cache to prevent ElevenLabs retries from spawning multiple parallel pipelines
const activeGenerations = new Map<string, { startedAt: number; abortController: AbortController }>()

export async function handleCustomLLMRequest(request: Request): Promise<Response> {
    console.log('[CustomLLM] ═══ NEW REQUEST ═══')
    console.log('[CustomLLM] Method:', request.method)
    console.log('[CustomLLM] URL:', request.url)

    // In production we should limit what we log from headers
    console.log('[CustomLLM] Origin:', request.headers.get('origin') || 'unknown')

    const body = await request.json()
    // Don't log the full giant body in production, just the shape
    console.log('[CustomLLM] Body received with keys:', Object.keys(body))

    // ── Extract the last user message from OpenAI-style messages ──
    const messages: Array<{ role: string; content: string }> = body.messages ?? []
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user')
    const userPrompt = lastUserMessage?.content ?? ''

    console.log(`[CustomLLM] Messages count: ${messages.length}`)
    console.log(`[CustomLLM] User prompt: "${userPrompt.slice(0, 100)}..."`)

    if (!userPrompt) {
        console.log('[CustomLLM] ✗ No user message found, returning 400')
        return new Response(
            JSON.stringify({ error: 'No user message found' }),
            { status: 400, headers: { 'Content-Type': 'application/json' } },
        )
    }

    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
        console.log('[CustomLLM] ✗ OPENAI_API_KEY missing, returning 500')
        return new Response(
            JSON.stringify({ error: 'OPENAI_API_KEY is missing' }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
        )
    }

    // ── Request Deduplication ──
    const promptKey = userPrompt.trim().toLowerCase().slice(0, 200)
    const existing = activeGenerations.get(promptKey)
    if (existing && Date.now() - existing.startedAt < 300_000) {
        console.log(`[CustomLLM] ⚡ Duplicate request detected for "${promptKey.slice(0, 50)}..." — sending hold message`)
        // IMPORTANT: Do NOT send empty [DONE] — ElevenLabs interprets that as
        // "agent has nothing to say" and after 3 empty retries, kills the session.
        // Instead, send a real spoken message so the TTS has something to play.
        const stream = new ReadableStream({
            start(controller) {
                const encoder = new TextEncoder()
                const holdMsg = { choices: [{ delta: { content: 'One moment please, I\'m still working on that. ' }, index: 0, finish_reason: null }] }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(holdMsg)}\n\n`))
                const doneChunk = { choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] }
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`))
                controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                controller.close()
            }
        })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    }

    // Register this new generation
    const generationAbortController = new AbortController()
    activeGenerations.set(promptKey, { startedAt: Date.now(), abortController: generationAbortController })

    const openai = createOpenAI({ apiKey })

    // ── Build the minimal AgentContext required by our flows ──
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

    // ── Abort signal for interruption handling ──
    // IMPORTANT: We do NOT couple request.signal to the generation abort controller.
    // ElevenLabs will disconnect and retry the same prompt on timeout (~10s),
    // which fires request.signal.abort. If we kill the generation on that signal,
    // we abort expensive LLM work that should continue running.
    //
    // Instead: request.signal only controls the SSE stream (stops writing to a
    // closed connection). The generation runs independently and is only aborted
    // if we explicitly decide to (e.g., a genuinely different prompt supersedes it).
    const requestAbortSignal = request.signal
    let streamAborted = false
    let deltaCount = 0

    function handleStreamDisconnect() {
        if (streamAborted) return
        streamAborted = true
        console.log(`[CustomLLM] ⚡ HTTP connection closed after ${deltaCount} deltas (generation continues running)`)
        // NOTE: We intentionally do NOT call generationAbortController.abort() here.
        // The generation should keep going — the next ElevenLabs retry will get the dedup response.
    }

    if (requestAbortSignal) {
        console.log('[CustomLLM] AbortSignal available, listening for disconnect')
        requestAbortSignal.addEventListener('abort', handleStreamDisconnect)
    } else {
        console.log('[CustomLLM] ⚠ No AbortSignal on request')
    }

    // ── Stream OpenAI Chat Completions–format SSE ──
    console.log('[CustomLLM] Creating ReadableStream...')
    const stream = new ReadableStream({
        async start(controller) {
            const encoder = new TextEncoder()

            function sendDelta(content: string) {
                if (streamAborted) {
                    // console.log(`[CustomLLM] ⚡ sendDelta SKIPPED (aborted): "${content.slice(0, 50)}..."`)
                    return
                }
                try {
                    deltaCount++
                    const chunk = {
                        choices: [{ delta: { content }, index: 0, finish_reason: null }],
                    }
                    const encoded = `data: ${JSON.stringify(chunk)}\n\n`
                    controller.enqueue(encoder.encode(encoded))
                    // console.log(`[CustomLLM] → Delta #${deltaCount}: "${content.slice(0, 80)}"`)
                } catch (err) {
                    streamAborted = true
                    console.log(`[CustomLLM] ✗ sendDelta ERROR (controller closed?):`, err)
                }
            }

            const collectedActions: AgentAction[] = []

            const emit = (event: AgentSSEEvent) => {
                if (streamAborted) {
                    return
                }
                // console.log(`[CustomLLM] ← SSE event: type=${event.type}`)
                switch (event.type) {
                    case 'text_delta':
                        sendDelta(event.delta)
                        break
                    case 'tool_call':
                        console.log(`[CustomLLM] ← tool_call: ${event.toolName}`)
                        // Send conversational text IMMEDIATELY so ElevenLabs has
                        // something to speak while the tool processes (~30-60s)
                        sendDelta(`Absolutely! Let me create a visualization for you. This will take a moment while I design it. `)
                        break
                    case 'final':
                        console.log(`[CustomLLM] ← final: ${event.actions.length} actions`)
                        collectedActions.push(...event.actions)
                        break
                    case 'error':
                        console.log(`[CustomLLM] ← error: ${event.message}`)
                        sendDelta(`Sorry, I encountered an error: ${event.message}. `)
                        break
                }
            }

            try {
                console.log('[CustomLLM] Calling runGraphFlow...')
                const flowResult = await runGraphFlow({ openai, request: agentRequest, emit, abortSignal: generationAbortController.signal })
                console.log(`[CustomLLM] runGraphFlow complete. messageStreamed=${flowResult.messageStreamed}, actions=${flowResult.actions.length}, aborted=${streamAborted}`)

                if (!streamAborted && !flowResult.messageStreamed) {
                    console.log(`[CustomLLM] Sending full assistantMessage`)
                    sendDelta(flowResult.assistantMessage)
                }

                // Push ALL completed visualizations to side-channel store
                // (frontend polls this — the SSE stream is usually already aborted)
                const allActions = [...collectedActions, ...flowResult.actions]
                for (const action of allActions) {
                    if (action.type === 'create_visualization' && action.config) {
                        pushVisualization(action.config)
                        console.log(`[CustomLLM] ✓ Pushed visualization to store: ${action.config.title}`)
                        if (!streamAborted) {
                            sendDelta(` I've created a visualization called "${action.config.title}". You can see it on the canvas now.`)
                        }
                    }
                }
            } catch (err) {
                if (streamAborted || (err as DOMException).name === 'AbortError') {
                    console.log('[CustomLLM] ⚡ Stream aborted during runGraphFlow (expected on interruption)')
                } else {
                    const errorMsg = err instanceof Error ? err.message : 'Unknown error'
                    console.log(`[CustomLLM] ✗ runGraphFlow ERROR: ${errorMsg}`)
                    sendDelta(`Sorry, something went wrong: ${errorMsg}`)
                }
            }



            // ── End the SSE stream ──
            if (!streamAborted) {
                try {
                    console.log(`[CustomLLM] Sending finish + [DONE] (total deltas: ${deltaCount})`)
                    const doneChunk = {
                        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
                    }
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(doneChunk)}\n\n`))
                    controller.enqueue(encoder.encode('data: [DONE]\n\n'))
                } catch (err) {
                    console.log('[CustomLLM] ✗ Error writing [DONE]:', err)
                }
            } else {
                console.log(`[CustomLLM] ⚡ Skipping [DONE] (stream was aborted at delta #${deltaCount})`)
            }
            try { controller.close() } catch { /* already closed */ }
            console.log('[CustomLLM] ═══ STREAM ENDED ═══')
            activeGenerations.delete(promptKey)
        },
    })

    console.log('[CustomLLM] Returning SSE Response')
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        },
    })
}
