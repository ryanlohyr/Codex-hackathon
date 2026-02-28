export type VisualizationType = 'solar-system' | 'molecule' | 'terrain' | 'concept-map'

export type RenderType = '3D_WEBGL' | '2D_CANVAS'

export type VisualizationTheme = 'light' | 'dark'

export type SliderDef = {
  key: string
  label: string
  min: number
  max: number
  step: number
  defaultValue: number
  unit?: string
}

export type ToggleDef = {
  key: string
  label: string
  defaultValue: boolean
}

export type ScaffoldStep = {
  instruction: string
  concept: string
  condition: string
}

export type TimelineEvent = {
  id: string
  label: string
  description: string
  year?: string
}

export type VisualizationControls = {
  title: string
  sliders: SliderDef[]
  toggles: ToggleDef[]
}

export type VisualizationConfig = {
  type: VisualizationType
  /** Defaults to '3D_WEBGL' when absent (backward compatibility with persisted data). */
  renderType?: RenderType
  /** Visual theme chosen by the teacher. Defaults to 'dark' when absent. */
  theme?: VisualizationTheme
  /** Whether this is a timeline-based visualization or a standard one. Defaults to 'standard'. */
  visualizationType?: 'timeline' | 'standard'
  params: Record<string, unknown>
  title: string
  summary: string
  generatedSceneCode?: string
  /** Free-text markdown lesson plan produced by the Teacher model. */
  blueprint?: string
  /** Runtime-rendered control panel definition. When present, the runtime renders sliders/toggles instead of the generated code. */
  controls?: VisualizationControls
  /** Runtime-rendered scaffolded steps. When present, the runtime renders the steps panel instead of the generated code. */
  scaffoldedSteps?: ScaffoldStep[]
  /** Timeline events for timeline-type visualizations. When present, the runtime renders a timeline panel at the bottom. */
  timelineEvents?: TimelineEvent[]
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
