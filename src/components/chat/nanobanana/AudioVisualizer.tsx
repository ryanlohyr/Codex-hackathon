import { motion } from 'framer-motion'

const BAR_COUNT = 24

export function AudioVisualizer({ isActive }: { isActive: boolean }) {
    return (
        <div
            style={{
                display: 'flex',
                height: 32,
                alignItems: 'flex-end',
                justifyContent: 'center',
                gap: 3,
                padding: '0 16px',
            }}
        >
            {Array.from({ length: BAR_COUNT }).map((_, i) => (
                <motion.div
                    key={i}
                    style={{
                        width: 5,
                        borderRadius: 9999,
                        background: isActive
                            ? 'linear-gradient(to top, #38bdf8, #818cf8)'
                            : '#cbd5e1',
                    }}
                    animate={
                        isActive
                            ? {
                                height: [4, 12 + Math.random() * 18, 6, 16 + Math.random() * 12, 4],
                            }
                            : { height: 4 }
                    }
                    transition={
                        isActive
                            ? {
                                duration: 0.6 + Math.random() * 0.5,
                                repeat: Infinity,
                                repeatType: 'mirror' as const,
                                delay: i * 0.04,
                                ease: 'easeInOut',
                            }
                            : { duration: 0.3 }
                    }
                />
            ))}
        </div>
    )
}
