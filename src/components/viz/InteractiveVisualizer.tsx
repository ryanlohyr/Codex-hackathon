import type { VisualizationConfig, VisualizationRuntimeState } from '../../types/visualization'
import { VisualizationCanvas } from './VisualizationCanvas'
import { Canvas2DEngine } from './Canvas2DEngine'

type InteractiveVisualizerProps = {
  config: VisualizationConfig
  runtimeState: VisualizationRuntimeState
}

/**
 * InteractiveVisualizer dynamically mounts the appropriate rendering engine
 * based on the visualization config's `renderType`.
 *
 * - "3D_WEBGL" → Three.js / R3F canvas (VisualizationCanvas)
 * - "2D_CANVAS" → HTML5 Canvas engine (Canvas2DEngine)
 */
export function InteractiveVisualizer({ config, runtimeState }: InteractiveVisualizerProps) {
  if (config.renderType === '2D_CANVAS') {
    return <Canvas2DEngine config={config} runtimeState={runtimeState} />
  }

  return <VisualizationCanvas config={config} runtimeState={runtimeState} />
}
