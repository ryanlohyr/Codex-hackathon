import type { VisualizationConfig } from '../../types/visualization'

// Simple in-memory queue for completed visualization configs.
// custom-llm-handler pushes, VoiceAgentWidget polls to pick them up.
// Dedup is handled upstream in custom-llm-handler (garbage filter + activeGenerations Set).

const pendingVisualizations: VisualizationConfig[] = []

export function pushVisualization(config: VisualizationConfig) {
    pendingVisualizations.push(config)
    console.log(`[VizStore] ✓ Pushed visualization: "${config.title}" (queue: ${pendingVisualizations.length})`)
}

export function popVisualizations(): VisualizationConfig[] {
    if (pendingVisualizations.length === 0) return []
    const result = [...pendingVisualizations]
    pendingVisualizations.length = 0
    console.log(`[VizStore] Popped ${result.length} visualizations`)
    return result
}
