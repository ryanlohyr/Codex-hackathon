import { motion } from 'framer-motion'
import { useAppStore } from '~/store/useAppStore'

const BAR_COUNT = 28

export function AudioVisualizer({ isActive }: { isActive: boolean }) {
    const theme = useAppStore((s) => s.theme)
    const isDark = theme === 'dark'

    return (
        <div
            style={{
                display: 'flex',
                width: '100%',
                height: '100%',
                alignItems: 'flex-end',
                justifyContent: 'center',
                gap: 2,
                padding: '0 8px 8px',
            }}
        >
            {Array.from({ length: BAR_COUNT }).map((_, i) => {
                const center = (BAR_COUNT - 1) / 2
                const distFromCenter = Math.abs(i - center) / center
                const maxH = 50 - distFromCenter * 36
                const minH = 3

                return (
                    <motion.div
                        key={i}
                        style={{
                            flex: 1,
                            maxWidth: 6,
                            borderRadius: 9999,
                            background: isActive
                                ? isDark
                                    ? `linear-gradient(to top, rgba(14,165,233,0.6), rgba(129,140,248,0.4))`
                                    : `linear-gradient(to top, rgba(8,145,178,0.5), rgba(56,189,248,0.3))`
                                : isDark
                                    ? 'rgba(100,116,139,0.15)'
                                    : 'rgba(148,163,184,0.2)',
                        }}
                        animate={
                            isActive
                                ? {
                                    height: [
                                        minH,
                                        maxH * (0.4 + Math.random() * 0.6),
                                        minH + 2,
                                        maxH * (0.3 + Math.random() * 0.7),
                                        minH,
                                    ],
                                }
                                : { height: minH }
                        }
                        transition={
                            isActive
                                ? {
                                    duration: 0.5 + Math.random() * 0.4,
                                    repeat: Infinity,
                                    repeatType: 'mirror' as const,
                                    delay: i * 0.03,
                                    ease: 'easeInOut',
                                }
                                : { duration: 0.4, ease: 'easeOut' }
                        }
                    />
                )
            })}
        </div>
    )
}
