import type { VisualizationConfig } from '../../types/visualization'

// Simple in-memory store for completed visualization configs.
// The custom-llm-handler pushes results here when generation completes.
// The VoiceAgentWidget polls to pick them up (since the ElevenLabs SSE stream
// is usually already disconnected by the time generation finishes).

const pendingVisualizations: VisualizationConfig[] = []

export function pushVisualization(config: VisualizationConfig) {
    pendingVisualizations.push(config)
    console.log(`[VizStore] Pushed visualization: ${config.title} (queue: ${pendingVisualizations.length})`)
}

export function popVisualizations(): VisualizationConfig[] {
    if (pendingVisualizations.length === 0) return []
    const result = [...pendingVisualizations]
    pendingVisualizations.length = 0
    console.log(`[VizStore] Popped ${result.length} visualizations`)
    return result
}
