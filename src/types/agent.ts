import type {
  ChatMessage,
  VisualizationCommand,
  VisualizationConfig,
  VisualizationRuntimeState,
} from './visualization'

export type AgentContext = {
  activeVisualizationId: string | null
  activeVisualizationConfig: VisualizationConfig | null
  activeRuntimeState: VisualizationRuntimeState
  recentMessages: Array<Pick<ChatMessage, 'role' | 'content'>>
}

export type AgentRequest = {
  prompt: string
  context: AgentContext
}

export type AgentRouteContext = {
  route: 'graph' | 'viz'
}

export type AgentStreamRequest = {
  prompt: string
  context: AgentContext
  routeContext: AgentRouteContext
}

export type AgentResponse = {
  assistantMessage: string
  createVisualization: VisualizationConfig | null
  commands: VisualizationCommand[]
}

export type VisualizationGenerationAttempt = {
  attemptNumber: number
  status: 'success' | 'schema_failed' | 'render_failed'
  errorSummary?: string
}

export type VisualizationValidationError = {
  phase: 'schema' | 'render'
  message: string
  details?: string[]
}

export type CreateVisualizationToolResult = {
  config: VisualizationConfig
  attempts: VisualizationGenerationAttempt[]
}

export type CreateVisualizationToolError = {
  attempts: VisualizationGenerationAttempt[]
  finalError: VisualizationValidationError
  suggestions: string[]
}

export type AgentAction =
  | { type: 'create_visualization'; config: VisualizationConfig }
  | { type: 'apply_command'; command: VisualizationCommand }
  | { type: 'update_visualization_code'; visualizationId: string; code: string }

export type AgentSSEEvent =
  | { type: 'message_start' }
  | { type: 'text_delta'; delta: string }
  | {
      type: 'tool_call'
      toolName: 'create_visualization'
      callId: string
      args: { prompt: string }
    }
  | {
      type: 'tool_result'
      callId: string
      result: CreateVisualizationToolResult
    }
  | {
      type: 'tool_error'
      callId: string
      error: CreateVisualizationToolError
    }
  | {
      type: 'blueprint_ready'
      callId: string
      blueprint: string
    }
  | {
      type: 'final'
      assistantMessage: string
      actions: AgentAction[]
    }
  | { type: 'error'; message: string }
  | { type: 'done' }
