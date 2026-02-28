import { motion, AnimatePresence } from 'framer-motion'

type MascotState = 'idle' | 'listening' | 'thinking' | 'speaking'

const MASCOT_ASSETS: Record<MascotState, { src: string; label: string }> = {
    idle: { src: '/idle.png', label: 'Ready' },
    listening: { src: '/listening.png', label: 'Listening...' },
    thinking: { src: '/thinking.png', label: 'Thinking...' },
    speaking: { src: '/speaking.png', label: 'Speaking...' },
}

const STATUS_COLORS: Record<MascotState, string> = {
    idle: '#34d399',
    listening: '#fbbf24',
    thinking: '#fbbf24',
    speaking: '#60a5fa',
}

export function Mascot({ state }: { state: MascotState }) {
    const asset = MASCOT_ASSETS[state]
    const isAnimating = state === 'speaking' || state === 'listening' || state === 'thinking'

    return (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ position: 'relative', width: 96, height: 96 }}>
                <AnimatePresence mode="wait">
                    <motion.img
                        key={asset.src}
                        src={asset.src}
                        alt={`Mascot ${state}`}
                        style={{
                            position: 'absolute',
                            inset: 0,
                            width: '100%',
                            height: '100%',
                            objectFit: 'contain',
                            filter: 'drop-shadow(0 4px 8px rgba(0,0,0,0.12))',
                        }}
                        initial={{ opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.25 }}
                    />
                </AnimatePresence>

                {/* Status indicator dot */}
                <span
                    style={{
                        position: 'absolute',
                        bottom: 4,
                        right: 12,
                        width: 12,
                        height: 12,
                        borderRadius: '50%',
                        border: '2px solid white',
                        background: STATUS_COLORS[state],
                        boxShadow: `0 0 6px ${STATUS_COLORS[state]}80`,
                        animation: isAnimating ? 'pulse 1.5s ease-in-out infinite' : 'none',
                    }}
                />
            </div>

            <motion.span
                key={asset.label}
                style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.15em',
                    color: '#64748b',
                }}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.2 }}
            >
                {asset.label}
            </motion.span>
        </div>
    )
}
