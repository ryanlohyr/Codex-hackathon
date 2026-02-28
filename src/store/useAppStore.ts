import { nanoid } from 'nanoid'
import type { Edge, Node } from 'reactflow'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { getVisualizationNodePosition } from '../lib/flow'
import type {
  ChatMessage,
  VisualizationCommand,
  VisualizationConfig,
  VisualizationNodeData,
  VisualizationRuntimeState,
} from '../types/visualization'

type Updater<T> = T | ((prev: T) => T)

type AppNode = Node<VisualizationNodeData>

type AppState = {
  theme: 'light' | 'dark'
  nodes: AppNode[]
  edges: Edge[]
  chatMessages: ChatMessage[]
  activeVisualizationId: string | null
  activeVisualizationState: VisualizationRuntimeState
  setTheme: (theme: 'light' | 'dark') => void
  toggleTheme: () => void
  addChatMessage: (message: ChatMessage) => void
  addVisualizationNode: (config: VisualizationConfig) => string
  upsertVisualizationNodeConfig: (id: string, config: VisualizationConfig) => void
  removeVisualizationNode: (id: string) => void
  setNodes: (nodes: Updater<AppNode[]>) => void
  setEdges: (edges: Updater<Edge[]>) => void
  setActiveVisualization: (id: string | null) => void
  applyVisualizationCommand: (cmd: VisualizationCommand) => void
}

const DEFAULT_TOGGLES: Record<string, boolean> = {
  showLabels: true,
  showOrbitRings: true,
  showSpeedLabels: false,
  showCues: true,
}

function createInitialRuntimeState(): VisualizationRuntimeState {
  return {
    params: {},
    toggles: { ...DEFAULT_TOGGLES },
    cues: [],
  }
}

function resolveUpdater<T>(updater: Updater<T>, prev: T): T {
  return typeof updater === 'function' ? (updater as (value: T) => T)(prev) : updater
}

export const useAppStore = create<AppState>()(
  persist(
    (set, get) => ({
      theme: 'light',
      nodes: [],
      edges: [],
      chatMessages: [
        {
          id: nanoid(),
          role: 'assistant',
          content:
            'Ask me to create a visualization. Then ask for cues like: "Are they spinning at the same speed?"',
          createdAt: Date.now(),
        },
      ],
      activeVisualizationId: null,
      activeVisualizationState: createInitialRuntimeState(),
      setTheme: (theme) => {
        set(() => ({ theme }))
      },
      toggleTheme: () => {
        set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' }))
      },
      addChatMessage: (message) => {
        set((state) => ({ chatMessages: [...state.chatMessages, message] }))
      },
      addVisualizationNode: (config) => {
        const id = nanoid()
        const nextNode: AppNode = {
          id,
          type: 'visualizationNode',
          position: getVisualizationNodePosition(get().nodes.length),
          data: {
            config,
            createdAt: Date.now(),
          },
        }

        set((state) => ({
          nodes: [...state.nodes, nextNode],
        }))

        return id
      },
      upsertVisualizationNodeConfig: (id, config) => {
        set((state) => {
          const exists = state.nodes.some((node) => node.id === id && node.type === 'visualizationNode')
          if (exists) {
            return {
              nodes: state.nodes.map((node) =>
                node.id === id && node.type === 'visualizationNode'
                  ? {
                      ...node,
                      data: {
                        ...node.data,
                        config,
                      },
                    }
                  : node,
              ),
            }
          }
          const newNode: AppNode = {
            id,
            type: 'visualizationNode',
            position: getVisualizationNodePosition(state.nodes.length),
            data: { config, createdAt: Date.now() },
          }
          return { nodes: [...state.nodes, newNode] }
        })
      },
      removeVisualizationNode: (id) => {
        set((state) => {
          const isRemovingActiveNode = state.activeVisualizationId === id

          return {
            nodes: state.nodes.filter((node) => node.id !== id),
            edges: state.edges.filter((edge) => edge.source !== id && edge.target !== id),
            activeVisualizationId: isRemovingActiveNode ? null : state.activeVisualizationId,
            activeVisualizationState: isRemovingActiveNode
              ? createInitialRuntimeState()
              : state.activeVisualizationState,
          }
        })
      },
      setNodes: (updater) => {
        set((state) => ({ nodes: resolveUpdater(updater, state.nodes) }))
      },
      setEdges: (updater) => {
        set((state) => ({ edges: resolveUpdater(updater, state.edges) }))
      },
      setActiveVisualization: (id) => {
        set(() => ({
          activeVisualizationId: id,
          activeVisualizationState: createInitialRuntimeState(),
        }))
      },
      applyVisualizationCommand: (cmd) => {
        const state = get()

        if (!state.activeVisualizationId) {
          state.addChatMessage({
            id: nanoid(),
            role: 'assistant',
            content: 'Open a visualization node first, then I can control the 3D scene.',
            createdAt: Date.now(),
          })
          return
        }

        set((prev) => {
          const runtime = prev.activeVisualizationState

          switch (cmd.action) {
            case 'set_param': {
              return {
                activeVisualizationState: {
                  ...runtime,
                  params: {
                    ...runtime.params,
                    [cmd.payload.key]: cmd.payload.value,
                  },
                },
              }
            }
            case 'set_toggle': {
              return {
                activeVisualizationState: {
                  ...runtime,
                  toggles: {
                    ...runtime.toggles,
                    [cmd.payload.name]: cmd.payload.enabled,
                  },
                },
              }
            }
            case 'upsert_cue': {
              const existing = runtime.cues.find((cue) => cue.id === cmd.payload.cue.id)
              const nextCues = existing
                ? runtime.cues.map((cue) => (cue.id === cmd.payload.cue.id ? cmd.payload.cue : cue))
                : [...runtime.cues, cmd.payload.cue]

              return {
                activeVisualizationState: {
                  ...runtime,
                  cues: nextCues,
                },
              }
            }
            case 'remove_cue': {
              return {
                activeVisualizationState: {
                  ...runtime,
                  cues: runtime.cues.filter((cue) => cue.id !== cmd.payload.id),
                },
              }
            }
            case 'clear_cues': {
              return {
                activeVisualizationState: {
                  ...runtime,
                  cues: [],
                },
              }
            }
            default: {
              return prev
            }
          }
        })
      },
    }),
    {
      name: 'mindcanvas-store-v1',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        theme: state.theme,
        nodes: state.nodes.map((node) =>
          node.type === 'visualizationNode'
            ? {
                ...node,
                data: {
                  ...node.data,
                  config: {
                    ...node.data.config,
                    generatedSceneCode: undefined,
                    blueprint: undefined,
                  },
                },
              }
            : node,
        ),
        edges: state.edges,
        chatMessages: state.chatMessages,
      }),
    },
  ),
)
