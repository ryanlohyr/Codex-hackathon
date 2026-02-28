export type VisualizationType = 'solar-system' | 'molecule' | 'terrain' | 'concept-map'

export type RenderType = '3D_WEBGL' | '2D_CANVAS'

export type VisualizationTheme = 'light' | 'dark'

export type VisualizationConfig = {
  type: VisualizationType
  /** Defaults to '3D_WEBGL' when absent (backward compatibility with persisted data). */
  renderType?: RenderType
  /** Visual theme chosen by the teacher. Defaults to 'dark' when absent. */
  theme?: VisualizationTheme
  params: Record<string, unknown>
  title: string
  summary: string
  generatedSceneCode?: string
  /** Free-text markdown lesson plan produced by the Teacher model. */
  blueprint?: string
}

export type ChatMessage = {
  id: string
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export type VisualizationNodeData = {
  config: VisualizationConfig
  createdAt: number
}

export type CueTarget = 'sun' | 'mercury' | 'venus' | 'earth' | 'system'

export type VisualizationCue = {
  id: string
  label: string
  target: CueTarget
  kind: 'label' | 'highlight' | 'note'
  color?: string
  note?: string
  visible?: boolean
}

export type VisualizationRuntimeState = {
  params: Record<string, unknown>
  toggles: Record<string, boolean>
  cues: VisualizationCue[]
}

export type VisualizationCommand =
  | {
      action: 'set_param'
      payload: {
        key: string
        value: unknown
      }
    }
  | {
      action: 'set_toggle'
      payload: {
        name: string
        enabled: boolean
      }
    }
  | {
      action: 'upsert_cue'
      payload: {
        cue: VisualizationCue
      }
    }
  | {
      action: 'remove_cue'
      payload: {
        id: string
      }
    }
  | {
      action: 'clear_cues'
      payload: Record<string, never>
    }
