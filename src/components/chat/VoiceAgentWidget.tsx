import { useState, useCallback, useEffect, useRef } from 'react'
import { useConversation } from '@elevenlabs/react'
import { useAppStore } from '~/store/useAppStore'
import { Mascot } from '~/components/chat/nanobanana/Mascot'
import { AudioVisualizer } from '~/components/chat/nanobanana/AudioVisualizer'
import { Mic, MicOff, Phone, PhoneOff, Volume2, VolumeX } from 'lucide-react'
import { motion, AnimatePresence } from 'framer-motion'

type MascotState = 'idle' | 'listening' | 'thinking' | 'speaking'

export function VoiceAgentWidget() {
    const theme = useAppStore((s) => s.theme)
    const addVisualizationNode = useAppStore((s) => s.addVisualizationNode)
    const [isExpanded, setIsExpanded] = useState(false)
    const [mascotState, setMascotState] = useState<MascotState>('idle')
    const [transcript, setTranscript] = useState<Array<{ role: 'user' | 'assistant'; text: string }>>([])
    const [isMuted, setIsMuted] = useState(false)
    const [isMicMuted, setIsMicMuted] = useState(false)
    const [isProcessingTool, setIsProcessingTool] = useState(false)
    // Ref mirrors isProcessingTool so onModeChange closure always reads latest value (fixes stale closure bug)
    const isProcessingToolRef = useRef(false)
    const chatEndRef = useRef<HTMLDivElement>(null)

    // Auto-scroll chat to bottom when new messages arrive
    useEffect(() => {
        chatEndRef.current?.scrollIntoView({ behavior: 'smooth' })
    }, [transcript])

    const agentId = import.meta.env.VITE_ELEVENLABS_AGENT_ID

    const conversation = useConversation({
        micMuted: isMicMuted,
        onConnect: () => {
            console.log('[VoiceAgent] Connected')
            setMascotState('idle')
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
        const interval = setInterval(async () => {
            try {
                const res = await fetch('/api/viz-results')
                const data = await res.json()
                if (data.configs && data.configs.length > 0) {
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
                }
            } catch (e) {
                // Silently ignore poll failures
            }
        }, 3000)
        return () => clearInterval(interval)
    }, [conversation.status, addVisualizationNode])

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

    const isDark = theme === 'dark'
    const isConnected = conversation.status === 'connected'

    // ── Collapsed FAB ──
    if (!isExpanded) {
        return (
            <motion.button
                onClick={() => {
                    setIsExpanded(true)
                    if (!isConnected) handleStartConversation()
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
            <div className="voice-chat-bubbles" style={{ position: 'fixed', bottom: 260, right: 24, display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'flex-end', width: 340, pointerEvents: 'none', zIndex: 9999, maxHeight: 'calc(100vh - 300px)', overflowY: 'auto', overflowX: 'hidden', paddingRight: 4, scrollbarWidth: 'none' as any }}>
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
                                padding: '12px 16px',
                                borderRadius: msg.role === 'user' ? '20px 20px 4px 20px' : '20px 20px 20px 4px',
                                fontSize: 14,
                                lineHeight: 1.5,
                                maxWidth: '90%',
                                backdropFilter: 'blur(10px)',
                                WebkitBackdropFilter: 'blur(10px)',
                                boxShadow: isDark ? '0 8px 32px rgba(0,0,0,0.4)' : '0 8px 32px rgba(0,0,0,0.1)',
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
                            {msg.text}
                        </motion.div>
                    ))}
                    {/* Typing indicator when agent is speaking/thinking */}
                    {(mascotState === 'speaking' || mascotState === 'thinking') && (transcript.length === 0 || transcript[transcript.length - 1].role === 'user') && (
                        <motion.div
                            layout
                            initial={{ opacity: 0, scale: 0.8, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.8, y: -20 }}
                            style={{
                                alignSelf: 'flex-start',
                                padding: '12px 16px',
                                borderRadius: '20px 20px 20px 4px',
                                background: isDark ? 'rgba(30,41,59,0.85)' : 'rgba(255,255,255,0.9)',
                                border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(0,0,0,0.05)',
                                backdropFilter: 'blur(10px)',
                                WebkitBackdropFilter: 'blur(10px)',
                                display: 'flex',
                                gap: 6,
                                alignItems: 'center',
                                pointerEvents: 'auto',
                                boxShadow: isDark ? '0 8px 32px rgba(0,0,0,0.4)' : '0 8px 32px rgba(0,0,0,0.1)',
                            }}
                        >
                            {[0, 1, 2].map((i) => (
                                <motion.span
                                    key={i}
                                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -3, 0] }}
                                    transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.2 }}
                                    style={{
                                        width: 6,
                                        height: 6,
                                        borderRadius: '50%',
                                        background: isDark ? '#38bdf8' : '#0891b2',
                                    }}
                                />
                            ))}
                        </motion.div>
                    )}
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
                        width: 340,
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
                    {/* ── Cute Floating Tool Processing Badge ── */}
                    <AnimatePresence>
                        {isProcessingTool && (
                            <motion.div
                                initial={{ opacity: 0, y: 15, scale: 0.8 }}
                                animate={{ opacity: 1, y: -20, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.8 }}
                                transition={{ type: 'spring', damping: 15, stiffness: 400 }}
                                style={{
                                    position: 'absolute',
                                    top: -15, // floats right above the main background
                                    left: '50%',
                                    transform: 'translateX(-50%)',
                                    background: isDark
                                        ? 'linear-gradient(135deg, #0891b2, #06b6d4)'
                                        : 'linear-gradient(135deg, #0891b2, #22d3ee)',
                                    padding: '8px 16px',
                                    borderRadius: '999px',
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    boxShadow: isDark
                                        ? '0 0 20px rgba(8,145,178,0.4)'
                                        : '0 10px 25px rgba(8,145,178,0.3)',
                                    border: '1px solid rgba(255,255,255,0.2)',
                                    zIndex: 10,
                                }}
                            >
                                <motion.span
                                    animate={{ rotate: 360 }}
                                    transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
                                    style={{ fontSize: 16, display: 'inline-block' }}
                                >
                                    ✨
                                </motion.span>
                                <span style={{ fontSize: 13, fontWeight: 700, color: '#fff', letterSpacing: '0.02em' }}>
                                    Doing magic...
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    {/* ── Header ── */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '16px 20px 8px',
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
                        </div>
                        <button
                            onClick={() => setIsExpanded(false)}
                            style={{
                                border: 'none',
                                background: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                                borderRadius: 6,
                                padding: '4px 10px',
                                fontSize: 10,
                                fontWeight: 600,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase' as const,
                                color: isDark ? '#94a3b8' : '#64748b',
                                cursor: 'pointer',
                            }}
                        >
                            ✕
                        </button>
                    </div>


                    {/* ── Mascot ── */}
                    <div style={{ display: 'flex', justifyContent: 'center', padding: '6px 0 2px' }}>
                        <Mascot state={mascotState} />
                    </div>

                    {/* ── Audio Visualizer ── */}
                    <div style={{ padding: '0 16px 4px' }}>
                        <AudioVisualizer isActive={conversation.isSpeaking} />
                    </div>

                    {/* ── Controls ── */}
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 16,
                            padding: '4px 20px 14px',
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
                                        width: 44,
                                        height: 44,
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
                                    {isMuted ? <VolumeX size={18} /> : <Volume2 size={18} />}
                                </motion.button>

                                {/* Hang up */}
                                <motion.button
                                    onClick={handleEndConversation}
                                    whileHover={{ scale: 1.06 }}
                                    whileTap={{ scale: 0.92 }}
                                    style={{
                                        width: 56,
                                        height: 56,
                                        borderRadius: '50%',
                                        border: 'none',
                                        cursor: 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        background: 'linear-gradient(135deg, #ef4444, #dc2626)',
                                        color: '#ffffff',
                                        boxShadow: '0 4px 16px rgba(239,68,68,0.35)',
                                    }}
                                    title="End conversation"
                                >
                                    <PhoneOff size={22} />
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
                                        width: 44,
                                        height: 44,
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
                                    {isMicMuted ? <MicOff size={18} /> : <Mic size={18} />}
                                </motion.button>
                            </>
                        ) : (
                            <motion.button
                                onClick={handleStartConversation}
                                whileHover={{ scale: 1.06 }}
                                whileTap={{ scale: 0.92 }}
                                style={{
                                    width: 56,
                                    height: 56,
                                    borderRadius: '50%',
                                    border: 'none',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    background: 'linear-gradient(135deg, #0891b2, #06b6d4)',
                                    color: '#ffffff',
                                    boxShadow: '0 4px 16px rgba(8,145,178,0.35)',
                                }}
                                title="Start conversation"
                            >
                                <Phone size={22} />
                            </motion.button>
                        )}
                    </div>
                </motion.div>
            </AnimatePresence>
        </>
    )
}
