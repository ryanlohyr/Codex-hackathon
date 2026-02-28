import { useEffect, useMemo, useRef, useState } from 'react'
import { nanoid } from 'nanoid'
import clsx from 'clsx'
import ReactMarkdown, { type Components } from 'react-markdown'
import { useLocation } from '@tanstack/react-router'
import { useAI } from '../../hooks/useAI'
import { saveVisualizationArtifact } from '../../server/visualization-artifacts'
import { useAppStore } from '../../store/useAppStore'
import type { AgentAction, AgentSSEEvent } from '../../types/agent'
import type { VisualizationCommand, VisualizationConfig } from '../../types/visualization'

function ChatMarkdown({ content, theme }: { content: string; theme: 'light' | 'dark' }) {
  const markdownComponents: Components = {
    p: ({ children }) => <p className="whitespace-pre-wrap break-words">{children}</p>,
    ul: ({ children }) => <ul className="list-disc space-y-1 pl-4">{children}</ul>,
    ol: ({ children }) => <ol className="list-decimal space-y-1 pl-4">{children}</ol>,
    li: ({ children }) => <li>{children}</li>,
    code: ({ children, className }) => {
      if (className) {
        return (
          <code
            className={clsx(
              'my-1 block overflow-x-auto rounded px-2 py-1 font-mono text-[11px]',
              theme === 'light' ? 'bg-slate-100 text-slate-800' : 'bg-slate-950/70 text-slate-100',
            )}
          >
            {children}
          </code>
        )
      }

      return (
        <code
          className={clsx(
            'rounded px-1 py-0.5 font-mono text-[11px]',
            theme === 'light' ? 'bg-slate-200/80 text-slate-800' : 'bg-slate-800 text-slate-100',
          )}
        >
          {children}
        </code>
      )
    },
    a: ({ children, href }) => (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={clsx('underline underline-offset-2', theme === 'light' ? 'text-cyan-700' : 'text-cyan-200')}
      >
        {children}
      </a>
    ),
  }

  return <ReactMarkdown components={markdownComponents}>{content}</ReactMarkdown>
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message
  }
  return 'Agent request failed. Please try again.'
}

function applyActions(
  actions: AgentAction[],
  args: {
    addVisualizationNode: (config: VisualizationConfig) => string
    applyVisualizationCommand: (command: VisualizationCommand) => void
    upsertVisualizationNodeConfig: (id: string, config: VisualizationConfig) => void
    getNodeConfig: (id: string) => VisualizationConfig | null
  },
): Array<{ id: string; config: VisualizationConfig }> {
  const persistableConfigs: Array<{ id: string; config: VisualizationConfig }> = []

  for (const action of actions) {
    if (action.type === 'create_visualization') {
      const id = args.addVisualizationNode(action.config)
      persistableConfigs.push({ id, config: action.config })
      continue
    }

    if (action.type === 'apply_command') {
      args.applyVisualizationCommand(action.command)
      continue
    }

    if (action.type === 'update_visualization_code') {
      const currentConfig = args.getNodeConfig(action.visualizationId)
      if (currentConfig) {
        const updatedConfig: VisualizationConfig = {
          ...currentConfig,
          generatedSceneCode: action.code,
        }
        args.upsertVisualizationNodeConfig(action.visualizationId, updatedConfig)
        persistableConfigs.push({ id: action.visualizationId, config: updatedConfig })
      }
    }
  }

  return persistableConfigs
}

export function ChatWidget() {
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [assistantDraft, setAssistantDraft] = useState('')
  const [toolUpdates, setToolUpdates] = useState<string[]>([])
  const [toolSuggestions, setToolSuggestions] = useState<string[]>([])

  const location = useLocation()
  const theme = useAppStore((state) => state.theme)
  const toggleTheme = useAppStore((state) => state.toggleTheme)
  const messages = useAppStore((state) => state.chatMessages)
  const nodes = useAppStore((state) => state.nodes)
  const activeVisualizationId = useAppStore((state) => state.activeVisualizationId)
  const activeVisualizationState = useAppStore((state) => state.activeVisualizationState)
  const addChatMessage = useAppStore((state) => state.addChatMessage)
  const addVisualizationNode = useAppStore((state) => state.addVisualizationNode)
  const upsertVisualizationNodeConfig = useAppStore((state) => state.upsertVisualizationNodeConfig)
  const applyVisualizationCommand = useAppStore((state) => state.applyVisualizationCommand)
  const { streamPrompt } = useAI()
  const messageListRef = useRef<HTMLDivElement | null>(null)

  const recentMessages = messages.slice(-5)
  const activeNode = activeVisualizationId
    ? nodes.find((node) => node.id === activeVisualizationId)
    : null

  const routeContext = useMemo(
    () => ({ route: location.pathname.startsWith('/viz/') ? 'viz' : 'graph' }) as const,
    [location.pathname],
  )

  useEffect(() => {
    if (!messageListRef.current) {
      return
    }
    messageListRef.current.scrollTop = messageListRef.current.scrollHeight
  }, [messages])

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()

    const trimmedPrompt = prompt.trim()
    if (!trimmedPrompt || submitting) {
      return
    }

    setSubmitting(true)
    setSubmitError(null)
    setAssistantDraft('')
    setToolUpdates([])
    setToolSuggestions([])
    setPrompt('')

    addChatMessage({
      id: nanoid(),
      role: 'user',
      content: trimmedPrompt,
      createdAt: Date.now(),
    })

    let finalMessage = ''
    let streamedMessage = ''
    const persistenceTasks: Array<Promise<unknown>> = []

    const onEvent = (agentEvent: AgentSSEEvent) => {
      switch (agentEvent.type) {
        case 'message_start': {
          setAssistantDraft('')
          break
        }
        case 'text_delta': {
          streamedMessage += agentEvent.delta
          setAssistantDraft((value) => value + agentEvent.delta)
          break
        }
        case 'tool_call': {
          setToolUpdates((value) => [...value, 'Generating visualization (attempt 1/3)...'])
          break
        }
        case 'tool_result': {
          for (const attempt of agentEvent.result.attempts) {
            if (attempt.status === 'success') {
              setToolUpdates((value) => [...value, `Attempt ${attempt.attemptNumber}/3: passed validation.`])
            }
            if (attempt.status === 'schema_failed') {
              setToolUpdates((value) => [...value, `Attempt ${attempt.attemptNumber}/3: schema failed (${attempt.errorSummary}).`])
            }
            if (attempt.status === 'render_failed') {
              setToolUpdates((value) => [...value, `Attempt ${attempt.attemptNumber}/3: render failed (${attempt.errorSummary}).`])
            }
          }
          break
        }
        case 'blueprint_ready': {
          setToolUpdates((value) => [...value, 'Lesson plan designed. Generating code...'])
          break
        }
        case 'tool_error': {
          for (const attempt of agentEvent.error.attempts) {
            setToolUpdates((value) => [...value, `Attempt ${attempt.attemptNumber}/3: ${attempt.status}.`])
          }
          setSubmitError(`${agentEvent.error.finalError.phase}: ${agentEvent.error.finalError.message}`)
          setToolSuggestions(agentEvent.error.suggestions.slice(0, 2))
          break
        }
        case 'final': {
          finalMessage = agentEvent.assistantMessage
          const persistableConfigs = applyActions(agentEvent.actions, {
            addVisualizationNode,
            applyVisualizationCommand,
            upsertVisualizationNodeConfig,
            getNodeConfig: (id: string) => {
              const node = nodes.find((n) => n.id === id)
              return node?.type === 'visualizationNode' ? node.data.config : null
            },
          })
          for (const created of persistableConfigs) {
            persistenceTasks.push(
              saveVisualizationArtifact({
                data: { id: created.id, config: created.config },
              }),
            )
          }
          break
        }
        case 'error': {
          setSubmitError(agentEvent.message)
          break
        }
        case 'done': {
          break
        }
      }
    }

    try {
      await streamPrompt({
        prompt: trimmedPrompt,
        context: {
          activeVisualizationId,
          activeVisualizationConfig:
            activeNode && activeNode.type === 'visualizationNode' ? activeNode.data.config : null,
          activeRuntimeState: activeVisualizationState,
          recentMessages: messages.slice(-8).map((message) => ({
            role: message.role,
            content: message.content,
          })),
        },
        routeContext,
        onEvent,
      })

      const content = (finalMessage || streamedMessage).trim()
      if (content.length > 0) {
        addChatMessage({
          id: nanoid(),
          role: 'assistant',
          content,
          createdAt: Date.now(),
        })
      }

      if (persistenceTasks.length > 0) {
        await Promise.allSettled(persistenceTasks)
      }
    } catch (error) {
      setSubmitError(getErrorMessage(error))
    } finally {
      setSubmitting(false)
      setAssistantDraft('')
    }
  }

  return (
    <div className="mc-chat-root pointer-events-none fixed bottom-4 right-4 z-50 w-[min(420px,calc(100vw-2rem))]">
      <div
        className={clsx(
          'mc-chat-card pointer-events-auto overflow-hidden rounded-2xl backdrop-blur-xl',
          theme === 'light'
            ? 'border border-slate-200 bg-white/85 text-slate-800 shadow-2xl shadow-slate-300/70'
            : 'border border-white/20 bg-slate-900/80 text-slate-100 shadow-2xl shadow-black/45',
        )}
      >
        <div className={clsx('px-4 py-3', theme === 'light' ? 'border-b border-slate-200' : 'border-b border-white/10')}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={clsx('text-xs uppercase tracking-[0.22em]', theme === 'light' ? 'text-cyan-700' : 'text-cyan-200/80')}>MindCanvas Agent</p>
              <p className={clsx('mt-1 text-sm', theme === 'light' ? 'text-slate-700' : 'text-slate-200/90')}>
                Graph: chat/create. Viz: iterative scene diffs and cues.
              </p>
            </div>
            <button
              type="button"
              onClick={toggleTheme}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs font-semibold',
                theme === 'light'
                  ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                  : 'bg-slate-800 text-slate-100 hover:bg-slate-700',
              )}
            >
              {theme === 'light' ? 'Dark' : 'Light'}
            </button>
          </div>
        </div>

        <div ref={messageListRef} className="mc-chat-list max-h-44 space-y-2 overflow-y-auto px-4 py-3">
          {recentMessages.map((message) => (
            <div
              key={message.id}
              className={clsx(
                'mc-chat-message rounded-lg px-3 py-2 text-xs leading-relaxed',
                message.role === 'user'
                  ? theme === 'light'
                    ? 'mc-chat-message-user ml-auto w-fit max-w-[90%] bg-cyan-100 text-cyan-900'
                    : 'mc-chat-message-user ml-auto w-fit max-w-[90%] bg-cyan-500/20 text-cyan-50'
                  : theme === 'light'
                    ? 'mc-chat-message-assistant bg-white text-slate-700'
                    : 'mc-chat-message-assistant bg-slate-900/50 text-slate-200',
              )}
            >
              <ChatMarkdown content={message.content} theme={theme} />
            </div>
          ))}

          {submitting ? (
            <div
              className={clsx(
                'mc-chat-message rounded-lg px-3 py-2 text-xs leading-relaxed',
                theme === 'light'
                  ? 'mc-chat-message-assistant bg-white text-slate-500'
                  : 'mc-chat-message-assistant bg-slate-900/50 text-slate-300',
              )}
            >
              <ChatMarkdown content={assistantDraft || 'Thinking...'} theme={theme} />
            </div>
          ) : null}
        </div>

        {toolUpdates.length > 0 ? (
          <div className={clsx('mx-3 mb-1 rounded-lg px-3 py-2 text-xs', theme === 'light' ? 'bg-slate-100 text-slate-700' : 'bg-slate-800/60 text-slate-200')}>
            {toolUpdates.slice(-3).map((line, index) => (
              <p key={`${line}-${index}`}>{line}</p>
            ))}
          </div>
        ) : null}

        {submitError ? (
          <div
            className={clsx(
              'mx-3 mb-1 rounded-lg px-3 py-2 text-xs',
              theme === 'light'
                ? 'border border-rose-200 bg-rose-50 text-rose-700'
                : 'border border-rose-500/40 bg-rose-500/10 text-rose-200',
            )}
          >
            <p>{submitError}</p>
            {toolSuggestions.map((suggestion) => (
              <p key={suggestion}>- {suggestion}</p>
            ))}
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          className={clsx(
            'mc-chat-form flex gap-2 p-3',
            theme === 'light' ? 'border-t border-slate-200' : 'border-t border-white/10',
          )}
        >
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Create a solar system, then add speed cues"
            className={clsx(
              'mc-chat-input min-w-0 flex-1 rounded-lg px-3 py-2 text-sm placeholder:text-slate-400 focus:outline-none',
              theme === 'light'
                ? 'border border-slate-300 bg-white text-slate-800 focus:border-cyan-500'
                : 'border border-white/20 bg-slate-950/70 text-slate-100 focus:border-cyan-300',
            )}
          />
          <button
            type="submit"
            disabled={submitting}
            className={clsx(
              'mc-chat-send rounded-lg px-3 py-2 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-70',
              theme === 'light'
                ? 'bg-cyan-600 text-white hover:bg-cyan-500'
                : 'bg-cyan-300 text-slate-950 hover:bg-cyan-200',
            )}
          >
            {submitting ? 'Streaming...' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  )
}
