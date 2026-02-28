import { useState, useCallback, useEffect, useRef, useMemo } from 'react'
import { useConversation } from '@elevenlabs/react'
import { useAppStore } from '~/store/useAppStore'
import { useLocation } from '@tanstack/react-router'
import { Mascot } from '~/components/chat/starry/Mascot'
import { AudioVisualizer } from '~/components/chat/starry/AudioVisualizer'
import { Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX, Send } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'
import Markdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import { useAI } from '~/hooks/useAI'

type MascotState = 'idle' | 'listening' | 'thinking' | 'speaking'

export function VoiceAgentWidget() {
    const theme = useAppStore((s) => s.theme)
    const addVisualizationNode = useAppStore((s) => s.addVisualizationNode)
    const upsertVisualizationNodeConfig = useAppStore((s) => s.upsertVisualizationNodeConfig)
    const activeVisualizationId = useAppStore((s) => s.activeVisualizationId)
    const activeVisualizationState = useAppStore((s) => s.activeVisualizationState)
    const nodes = useAppStore((s) => s.nodes)
    const location = useLocation()
    const routeContext = useMemo(
        () => ({ route: location.pathname.startsWith('/viz/') ? 'viz' : 'graph' }) as const,
        [location.pathname],
    )
    const activeNode = useMemo(
        () => (activeVisualizationId ? nodes.find((node) => node.id === activeVisualizationId) : null),
        [activeVisualizationId, nodes],
    )
    const activeVisualizationConfig = useMemo(
        () => (activeNode && activeNode.type === 'visualizationNode' ? activeNode.data.config : null),
        [activeNode],
    )
    const [isExpanded, setIsExpanded] = useState(false)
    const [mascotState, setMascotState] = useState<MascotState>('idle')
    const [transcript, setTranscript] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
    const [isMuted, setIsMuted] = useState(false)
    const [isMicMuted, setIsMicMuted] = useState(false)
    const [isProcessingTool, setIsProcessingTool] = useState(false)
    // Ref mirrors isProcessingTool so onModeChange closure always reads latest value (fixes stale closure bug)
    const isProcessingToolRef = useRef(false)
    const chatEndRef = useRef<HTMLDivElement>(null)
    // Session counter — incremented on "New chat" to ignore stale viz-poll results from previous sessions
    const sessionIdRef = useRef(0)
    // Flag for re-applying mute after session restart (used by onConnect callback)
    const pendingMuteRef = useRef(false)
    const [textInput, setTextInput] = useState('')
    const [isSending, setIsSending] = useState(false)
    const [isResettingChat, setIsResettingChat] = useState(false)
    const { streamPrompt } = useAI()

    // Auto-scroll chat to bottom when new messages arrive
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [transcript.length])

    const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID

    const conversation = useConversation({
        micMuted: isMicMuted,
        onConnect: () => {
            console.log('[VoiceAgent] Connected')
            setMascotState('idle')
            // Re-apply mute after session restart (fixes timing issue where setVolume is called before WebRTC is ready)
            if (pendingMuteRef.current) {
                pendingMuteRef.current = false
                conversation.setVolume({ volume: 0 })
                console.log('[VoiceAgent] Re-applied mute after session restart')
            }
        },
        onDisconnect: () => {
            console.log('[VoiceAgent] Disconnected')
            setMascotState('idle')
        },
        onMessage: (message) => {
            const msg = message as { role?: string; message?: string; source?: string }
            const role = msg.role ?? msg.source ?? 'assistant'
            const text = msg.message ?? ''
            console.log(`[VoiceAgent] onMessage: role=${role} text="${text?.slice(0, 80)}"`)

            if (!text) return

            if (role === 'user') {
                // Filter garbage transcriptions (ElevenLabs sends "......" for silence)
                const cleaned = text.replace(/[.\s…]+/g, '').trim()
                if (cleaned.length < 2) {
                    console.log(`[VoiceAgent] 🚫 Filtered garbage user message: "${text}"`)
                    return
                }
                setTranscript((prev) => [...prev.slice(-8), { role: 'user', text }])
            } else {
                // Detect our new backend ack message — signals tool is running in background
                const isBackendAck =
                    text.includes("Got it! I'm working") ||
                    text.includes("Check the canvas")

                if (isBackendAck) {
                    setIsProcessingTool(true)
                    isProcessingToolRef.current = true
                    setMascotState('thinking')
                }

                setTranscript((prev) => [...prev.slice(-8), { role: 'assistant', text }])
            }
        },
        onModeChange: (mode: { mode: string }) => {
            console.log('[VoiceAgent] Mode change:', mode)
            if (mode.mode === 'listening') {
                // Read from ref (not state) to avoid stale closure — ref is always current
                if (!isProcessingToolRef.current) {
                    setMascotState('listening')
                }
            } else if (mode.mode === 'speaking') {
                setMascotState('speaking')
            } else if (mode.mode === 'thinking') {
                setMascotState('thinking')
                setIsProcessingTool(true)
                isProcessingToolRef.current = true
            }
        },
        onInterruption: () => {
            console.log('[VoiceAgent] ⚡ INTERRUPTION detected — user spoke over agent')
            setMascotState('listening')
        },
        onError: (error) => {
            console.error('[VoiceAgent] Error:', error)
        },
    })

    useEffect(() => {
        if (conversation.status === 'disconnected') {
            setMascotState('idle')
            return
        }
        if (conversation.isSpeaking) {
            setMascotState('speaking')
        }
    }, [conversation.status, conversation.isSpeaking])

    // ── Poll for completed visualizations (side-channel from backend) ──
    useEffect(() => {
        // Capture session ID at effect creation time — if it changes (New chat), ignore stale results
        const capturedSessionId = sessionIdRef.current

        const interval = setInterval(async () => {
            try {
                const res = await fetch('/api/viz-results')
                const data = await res.json()
                if (data.configs && data.configs.length > 0) {
                    // Ignore results from a previous session
                    if (sessionIdRef.current !== capturedSessionId) {
                        console.log('[VoiceAgent] ⚡ Ignoring stale viz-results from previous session')
                        return
                    }
                    for (const config of data.configs) {
                        addVisualizationNode(config)
                        console.log(`[VoiceAgent] ✨ Visualization added: ${config.title}`)
                    }
                    setIsProcessingTool(false)
                    isProcessingToolRef.current = false
                    setMascotState(conversation.status === 'connected' ? 'listening' : 'idle')
                    setTranscript((prev) => [...prev.slice(-8), {
                        role: 'assistant' as const,
                        text: `I've created your visualization! You can see it on the canvas now.`,
                    }])
                    // Trigger ElevenLabs to speak confirmation — backend VIZ_READY gate returns ack without runGraphFlow
                    if (conversation.status === 'connected') {
                        try {
                            conversation.sendUserMessage('[VIZ_READY] The visualization is ready on the canvas.')
                            console.log('[VoiceAgent] ✅ Sent VIZ_READY to trigger spoken confirmation')
                        } catch (e) {
                            console.log('[VoiceAgent] sendUserMessage unavailable, skipping spoken confirmation')
                        }
                    }
                }
            } catch (e) {
                // Silently ignore poll failures
            }
        }, 3000)
        return () => clearInterval(interval)
    }, [conversation.status, conversation, addVisualizationNode])

    const handleStartConversation = useCallback(async () => {
        if (!agentId) {
            console.error('[VoiceAgent] No agent ID configured')
            return
        }
        try {
            // The SDK handles mic access internally — don't call getUserMedia ourselves
            await conversation.startSession({ agentId, connectionType: 'webrtc' })
            setIsExpanded(true)
        } catch (error) {
            console.error('[VoiceAgent] Failed to start:', error)
        }
    }, [agentId, conversation])

    const handleEndConversation = useCallback(async () => {
        await conversation.endSession()
        setMascotState('idle')
    }, [conversation])

    const handleToggleMute = useCallback(() => {
        if (isMuted) {
            conversation.setVolume({ volume: 1 })
            console.log('[VoiceAgent] Agent unmuted (volume 1)')
        } else {
            conversation.setVolume({ volume: 0 })
            console.log('[VoiceAgent] Agent muted (volume 0)')
        }
        setIsMuted(!isMuted)
    }, [conversation, isMuted])

    const handleStartNewChat = useCallback(async () => {
        if (isResettingChat) return

        // Increment session ID so the viz-poll ignores stale results from this session
        sessionIdRef.current += 1

        setTranscript([])
        setTextInput('')
        setIsProcessingTool(false)
        isProcessingToolRef.current = false
        setMascotState(conversation.status === 'connected' ? 'thinking' : 'idle')

        if (conversation.status !== 'connected') {
            return
        }

        if (!agentId) {
            console.error('[VoiceAgent] Cannot reset session context: missing agent ID')
            setMascotState('idle')
            return
        }

        setIsResettingChat(true)

        try {
            await conversation.endSession()
            // Schedule mute re-application for when the new session connects
            if (isMuted) {
                pendingMuteRef.current = true
            }
            await conversation.startSession({ agentId, connectionType: 'webrtc' })
        } catch (error) {
            console.error('[VoiceAgent] Failed to reset ElevenLabs session context:', error)
            setMascotState('idle')
        } finally {
            setIsResettingChat(false)
        }
    }, [isResettingChat, conversation, agentId, isMuted])

    const isDark = theme === 'dark'
    const isConnected = conversation.status === 'connected'

    const handleSendText = useCallback(async () => {
        const text = textInput.trim()
        if (!text || isSending) return

        setTextInput('')
        setTranscript((prev) => [...prev.slice(-8), { role: 'user', text }])
        setIsSending(true)
        setMascotState('thinking')

        let assistantText = ''

        try {
            await streamPrompt({
                prompt: text,
                context: {
                    activeVisualizationId,
                    activeVisualizationConfig,
                    activeRuntimeState: activeVisualizationState,
                    recentMessages: transcript.slice(-5).map((m) => ({ role: m.role, content: m.text })),
                },
                routeContext,
                onEvent: (event) => {
                    console.log('[VoiceAgent] onEvent:', JSON.stringify(event, null, 2))
                    if (event.type === 'text_delta' && event.delta) {
                        assistantText += event.delta
                        setTranscript((prev) => {
                            const lastMsg = prev[prev.length - 1]
                            if (lastMsg?.role === 'assistant') {
                                return [...prev.slice(0, -1), { role: 'assistant' as const, text: assistantText }]
                            } else {
                                return [...prev, { role: 'assistant', text: assistantText }].slice(-9)
                            }
                        })
                    } else if (event.type === 'tool_call') {
                        setIsProcessingTool(true)
                        isProcessingToolRef.current = true
                        setMascotState('speaking')
                    } else if (event.type === 'blueprint_ready') {
                        setTranscript((prev) => [...prev.slice(-8), { role: 'assistant', text: 'Lesson plan ready. Generating visualization...' }])
                    } else if (event.type === 'final' && event.actions) {
                        setIsProcessingTool(false)
                        isProcessingToolRef.current = false
                        for (const action of event.actions) {
                            if (action.type === 'create_visualization' && action.config) {
                                addVisualizationNode(action.config)
                            } else if (action.type === 'update_visualization_code') {
                                const currentNode = nodes.find((n) => n.id === action.visualizationId)
                                const currentConfig = currentNode?.type === 'visualizationNode' ? currentNode.data.config : null
                                if (currentConfig) {
                                    const updatedConfig = {
                                        ...currentConfig,
                                        generatedSceneCode: action.code,
                                    }
                                    upsertVisualizationNodeConfig(action.visualizationId, updatedConfig)
                                }
                            }
                        }
                    }
                },
            })

            if (!assistantText) {
                setTranscript((prev) => [...prev.slice(-8), { role: 'assistant', text: 'Done! Check the canvas.' }])
            }
        } catch (error) {
            console.error('[VoiceAgent] Text send error:', error)
            setTranscript((prev) => [...prev.slice(-8), { role: 'assistant', text: 'Something went wrong. Please try again.' }])
        } finally {
            setIsSending(false)
            setIsProcessingTool(false)
            isProcessingToolRef.current = false
            setMascotState(isConnected ? 'listening' : 'idle')
        }
    }, [textInput, isSending, isConnected, addVisualizationNode, upsertVisualizationNodeConfig, streamPrompt, transcript, routeContext, activeVisualizationId, activeVisualizationConfig, activeVisualizationState, nodes])

    // ── Collapsed FAB ──
    if (!isExpanded) {
        return (
            <motion.button
                onClick={() => {
                    setIsExpanded(true)
                }}
                initial={{ scale: 0, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                style={{
                    position: 'fixed',
                    bottom: 24,
                    right: 24,
                    zIndex: 9999,
                    width: 72,
                    height: 72,
                    borderRadius: '50%',
                    border: 'none',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    background: isDark
                        ? 'radial-gradient(circle at 30% 30%, #1e293b, #0f172a)'
                        : 'radial-gradient(circle at 30% 30%, #ffffff, #f1f5f9)',
                    boxShadow: isDark
                        ? '0 6px 24px rgba(0,0,0,0.4)'
                        : '0 6px 24px rgba(30,41,59,0.15)',
                }}
                whileHover={{
                    scale: 1.1, boxShadow: isDark
                        ? '0 8px 32px rgba(0,0,0,0.5)'
                        : '0 8px 32px rgba(30,41,59,0.2)'
                }}
                whileTap={{ scale: 0.95 }}
            >
                <img
                    src="/idle.png"
                    alt="MindCanvas Agent"
                    style={{
                        width: 56,
                        height: 56,
                        objectFit: 'contain',
                        filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.15))',
                    }}
                />
                {/* Online dot */}
                <span
                    style={{
                        position: 'absolute',
                        bottom: 3,
                        right: 3,
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: '#22c55e',
                        border: `2.5px solid ${isDark ? '#0f172a' : '#ffffff'}`,
                        boxShadow: '0 0 6px rgba(34,197,94,0.4)',
                    }}
                />
            </motion.button>
        )
    }

    // ── Expanded card ──
    return (
        <>
            {/* ── Floating Chat Bubbles ── */}
            {/* hide scrollbar CSS */}
            <style>{`.voice-chat-bubbles::-webkit-scrollbar { display: none; }`}</style>
            <div className="voice-chat-bubbles" style={{ position: 'fixed', bottom: 310, right: 24, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', width: 280, pointerEvents: 'none', zIndex: 9999, maxHeight: 'calc(100vh - 350px)', overflowY: 'auto', overflowX: 'hidden', paddingRight: 4, scrollbarWidth: 'none' as any }}>
                <AnimatePresence mode="popLayout">
                    {transcript.map((msg, i) => (
                        <motion.div
                            key={i}
                            layout
                            initial={{ opacity: 0, scale: 0.8, y: 20, rotateX: -15 }}
                            animate={{ opacity: 1, scale: 1, y: 0, rotateX: 0 }}
                            exit={{ opacity: 0, scale: 0.8, y: -20 }}
                            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                            style={{
                                justifySelf: 'flex-end',
                                padding: '10px 14px',
                                borderRadius: msg.role === 'user' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                                fontSize: 13,
                                lineHeight: 1.5,
                                maxWidth: '90%',
                                backdropFilter: 'blur(10px)',
                                WebkitBackdropFilter: 'blur(10px),',
                                pointerEvents: 'auto',
                                ...(msg.role === 'user'
                                    ? {
                                        background: isDark ? 'linear-gradient(135deg, #0891b2, #06b6d4)' : 'linear-gradient(135deg, #0ea5e9, #38bdf8)',
                                        color: '#ffffff',
                                        alignSelf: 'flex-end'
                                    }
                                    : {
                                        background: isDark ? 'rgba(30,41,59,0.85)' : 'rgba(255,255,255,0.9)',
                                        border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.05)',
                                        color: isDark ? '#f8fafc' : '#1e293b',
                                        alignSelf: 'flex-start'
                                    }),
                            }}
                        >
                            <Markdown
                                remarkPlugins={[remarkMath]}
                                rehypePlugins={[rehypeKatex]}
                                components={{
                                    p: ({ children }) => <p style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{children}</p>,
                                    ul: ({ children }) => <ul style={{ margin: '4px 0', paddingLeft: 16, listStyleType: 'disc' }}>{children}</ul>,
                                    ol: ({ children }) => <ol style={{ margin: '4px 0', paddingLeft: 16, listStyleType: 'decimal' }}>{children}</ol>,
                                    li: ({ children }) => <li style={{ marginBottom: 2 }}>{children}</li>,
                                    code: ({ children, className }) => (
                                        <code style={{
                                            ...(className
                                                ? { display: 'block', overflowX: 'auto', borderRadius: 6, padding: '4px 8px', margin: '4px 0', fontSize: 11 }
                                                : { borderRadius: 4, padding: '1px 4px', fontSize: 11 }),
                                            background: isDark ? 'rgba(0,0,0,0.3)' : 'rgba(0,0,0,0.06)',
                                            fontFamily: 'monospace',
                                        }}>{children}</code>
                                    ),
                                    a: ({ children, href }) => (
                                        <a href={href} target="_blank" rel="noreferrer" style={{ color: isDark ? '#67e8f9' : '#0891b2', textDecoration: 'underline' }}>{children}</a>
                                    ),
                                }}
                            >
                                {msg.text}
                            </Markdown>
                        </motion.div>
                    ))}
                    {/* Auto-scroll anchor */}
                    <div ref={chatEndRef} />
                </AnimatePresence>
            </div>

            <AnimatePresence>
                <motion.div
                    initial={{ opacity: 0, y: 20, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 20, scale: 0.95 }}
                    transition={{ type: 'spring', damping: 25, stiffness: 350 }}
                    style={{
                        position: 'fixed',
                        bottom: 24,
                        right: 24,
                        zIndex: 9999,
                        width: 280,
                        borderRadius: 20,
                        overflow: 'visible',
                        background: isDark
                            ? 'rgba(15, 23, 42, 0.92)'
                            : 'rgba(255, 255, 255, 0.95)',
                        border: isDark
                            ? '1px solid rgba(255,255,255,0.1)'
                            : '1px solid rgba(148,163,184,0.2)',
                        boxShadow: isDark
                            ? '0 25px 60px -12px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.05)'
                            : '0 25px 60px -12px rgba(30,41,59,0.2), 0 0 40px -15px rgba(56,189,248,0.1)',
                        backdropFilter: 'blur(20px)',
                        WebkitBackdropFilter: 'blur(20px)',
                        display: 'flex',
                        flexDirection: 'column' as const,
                    }}
                >
                    {/* ── Header with inline processing badge ── */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '12px 16px 6px',
                        }}
                    >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div
                                style={{
                                    width: 8,
                                    height: 8,
                                    borderRadius: '50%',
                                    background: isConnected ? '#22c55e' : '#94a3b8',
                                    boxShadow: isConnected ? '0 0 8px rgba(34,197,94,0.5)' : 'none',
                                }}
                            />
                            <span
                                style={{
                                    fontSize: 11,
                                    fontWeight: 700,
                                    letterSpacing: '0.12em',
                                    textTransform: 'uppercase' as const,
                                    color: isDark ? '#38bdf8' : '#0891b2',
                                }}
                            >
                                MindCanvas
                            </span>
                            {/* Inline processing badge */}
                            <AnimatePresence>
                                {isProcessingTool && (
                                    <motion.span
                                        initial={{ opacity: 0, scale: 0.8, x: -8 }}
                                        animate={{ opacity: 1, scale: 1, x: 0 }}
                                        exit={{ opacity: 0, scale: 0.8, x: -8 }}
                                        transition={{ type: 'spring', damping: 20, stiffness: 400 }}
                                        style={{
                                            background: isDark
                                                ? 'linear-gradient(135deg, #0891b2, #06b6d4)'
                                                : 'linear-gradient(135deg, #0891b2, #22d3ee)',
                                            padding: '3px 10px',
                                            borderRadius: '999px',
                                            display: 'inline-flex',
                                            alignItems: 'center',
                                            gap: 5,
                                            fontSize: 10,
                                            fontWeight: 700,
                                            color: '#fff',
                                            letterSpacing: '0.02em',
                                        }}
                                    >
                                        <motion.span
                                            animate={{ rotate: 360 }}
                                            transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                                            style={{ fontSize: 12, display: 'inline-block' }}
                                        >
                                            ✨
                                        </motion.span>
                                        Generating...
                                    </motion.span>
                                )}
                            </AnimatePresence>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {(() => {
                                const headerBtnStyle = {
                                    border: 'none',
                                    background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                                    borderRadius: 6,
                                    padding: '3px 8px',
                                    fontSize: 10,
                                    fontWeight: 600,
                                    letterSpacing: '0.08em',
                                    textTransform: 'uppercase' as const,
                                    color: isDark ? '#94a3b8' : '#64748b',
                                } as const
                                return (
                                    <>
                                        <button
                                            onClick={handleStartNewChat}
                                            disabled={isSending || isResettingChat}
                                            style={{
                                                ...headerBtnStyle,
                                                cursor: isSending || isResettingChat ? 'default' : 'pointer',
                                                opacity: isSending || isResettingChat ? 0.45 : 1,
                                            }}
                                            title="Start a new chat"
                                        >
                                            {isResettingChat ? 'Resetting…' : 'New chat'}
                                        </button>
                                        <button
                                            onClick={() => setIsExpanded(false)}
                                            style={{ ...headerBtnStyle, cursor: 'pointer' }}
                                        >
                                            ✕
                                        </button>
                                    </>
                                )
                            })()}
                        </div>
                    </div>


                    {/* ── Mascot + Audio Visualizer (background layer) ── */}
                    <div style={{ position: 'relative', display: 'flex', justifyContent: 'center', padding: '4px 0 4px', minHeight: 110 }}>
                        {/* Visualizer fills the bottom half — hidden when idle */}
                        {isConnected && (
                            <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '50%', zIndex: 0, opacity: 0.6 }}>
                                <AudioVisualizer isActive={conversation.isSpeaking} />
                            </div>
                        )}
                        {/* Mascot on top */}
                        <div style={{ position: 'relative', zIndex: 1 }}>
                            <Mascot state={mascotState} />
                        </div>
                    </div>

                    {/* ── Controls ── */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 12,
                            padding: '2px 16px 12px',
                        }}
                    >
                        {isConnected ? (
                            <>
                                {/* Mute */}
                                <motion.button
                                    onClick={handleToggleMute}
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    style={{
                                        width: 36,
                                        height: 36,
                                        borderRadius: '50%',
                                        border: 'none',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                                        color: isDark ? '#e2e8f0' : '#334155',
                                    }}
                                    title={isMuted ? 'Unmute' : 'Mute'}
                                >
                                    {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
                                </motion.button>

                                {/* Hang up */}
                                <motion.button
                                    onClick={handleEndConversation}
                                    whileHover={{ scale: 1.06 }}
                                    whileTap={{ scale: 0.92 }}
                                    style={{
                                        width: 44,
                                        height: 44,
                                        borderRadius: '50%',
                                        border: 'none',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                                        color: '#ffffff',
                                        boxShadow: '0 4px 12px rgba(239,68,68,0.3)',
                                    }}
                                    title="End conversation"
                                >
                                    <PhoneOff size={18} />
                                </motion.button>

                                {/* Mic mute toggle */}
                                <motion.button
                                    onClick={() => {
                                        setIsMicMuted(!isMicMuted)
                                        console.log(`[VoiceAgent] Mic ${!isMicMuted ? 'muted' : 'unmuted'}`)
                                    }}
                                    whileHover={{ scale: 1.08 }}
                                    whileTap={{ scale: 0.92 }}
                                    style={{
                                        width: 36,
                                        height: 36,
                                        borderRadius: '50%',
                                        border: 'none',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: isMicMuted
                                            ? 'rgba(239,68,68,0.15)'
                                            : isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)',
                                        color: isMicMuted
                                            ? '#ef4444'
                                            : mascotState === 'listening' || mascotState === 'thinking'
                                                ? '#0891b2'
                                                : isDark ? '#475569' : '#94a3b8',
                                    }}
                                    title={isMicMuted ? 'Unmute mic' : 'Mute mic'}
                                >
                                    {isMicMuted ? <MicOff size={16} /> : <Mic size={16} />}
                                </motion.button>
                            </>
                        ) : (
                            <motion.button
                                onClick={handleStartConversation}
                                whileHover={{ scale: 1.06 }}
                                whileTap={{ scale: 0.92 }}
                                style={{
                                    width: 44,
                                    height: 44,
                                    borderRadius: '50%',
                                    border: 'none',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: 'linear-gradient(135deg, #0891b2, #06b6d4)',
                                    color: '#ffffff',
                                    boxShadow: '0 4px 12px rgba(8,145,178,0.3)',
                                }}
                                title="Start conversation"
                            >
                                <Phone size={18} />
                            </motion.button>
                        )}
                    </div>

                    {/* ── Text Input Bar ── */}
                    <div style={{ padding: '0 12px 12px', display: 'flex', gap: 8, alignItems: 'center' }}>
                        <input
                            type="text"
                            value={textInput}
                            onChange={(e) => setTextInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendText() } }}
                            placeholder="Type a message..."
                            disabled={isSending}
                            style={{
                                flex: 1,
                                padding: '8px 12px',
                                borderRadius: 12,
                                border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.1)',
                                background: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)',
                                color: isDark ? '#f8fafc' : '#1e293b',
                                fontSize: 13,
                                outline: 'none',
                                opacity: isSending ? 0.5 : 1,
                            }}
                        />
                        <motion.button
                            onClick={handleSendText}
                            whileHover={{ scale: 1.08 }}
                            whileTap={{ scale: 0.92 }}
                            disabled={!textInput.trim() || isSending}
                            style={{
                                width: 36,
                                height: 36,
                                borderRadius: '50%',
                                border: 'none',
                                cursor: textInput.trim() && !isSending ? 'pointer' : 'default',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                background: textInput.trim() && !isSending
                                    ? 'linear-gradient(135deg, #0891b2, #06b6d4)'
                                    : isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                                color: textInput.trim() && !isSending ? '#ffffff' : isDark ? '#475569' : '#94a3b8',
                            }}
                        >
                            <Send size={14} />
                        </motion.button>
                    </div>
                </motion.div>
            </AnimatePresence>
        </>
    )
}
