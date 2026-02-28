import { useState, useEffect, useCallback } from 'react'
import type {
  TimelineEvent,
  VisualizationTheme,
  VisualizationRuntimeState,
} from '../../types/visualization'

type RuntimeTimelinePanelProps = {
  events: TimelineEvent[]
  theme?: VisualizationTheme
  runtimeState: VisualizationRuntimeState
}

export function RuntimeTimelinePanel({
  events,
  theme,
  runtimeState,
}: RuntimeTimelinePanelProps) {
  const [activeIndex, setActiveIndex] = useState(0)

  const isLight = theme === 'light'

  // Sync active index to runtimeState so generated code can read it
  useEffect(() => {
    runtimeState.params.__timelineIndex = activeIndex
  }, [activeIndex, runtimeState])

  const goBack = useCallback(() => {
    setActiveIndex((i) => Math.max(0, i - 1))
  }, [])

  const goForward = useCallback(() => {
    setActiveIndex((i) => Math.min(events.length - 1, i + 1))
  }, [events.length])

  if (events.length === 0) return null

  const panelBg = isLight ? 'rgba(250, 245, 235, 0.92)' : 'rgba(15, 23, 42, 0.88)'
  const panelBorder = isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.12)'
  const textPrimary = isLight ? '#1e293b' : '#e2e8f0'
  const textMuted = isLight ? '#64748b' : '#94a3b8'
  const accentColor = isLight ? '#0891b2' : '#22d3ee'
  const trackBg = isLight ? 'rgba(0, 0, 0, 0.08)' : 'rgba(255, 255, 255, 0.08)'

  const currentEvent = events[activeIndex]

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 16,
        left: 16,
        right: 16,
        zIndex: 20,
        background: panelBg,
        border: `1px solid ${panelBorder}`,
        borderRadius: 12,
        padding: '12px 16px',
        color: textPrimary,
        fontFamily: 'system-ui, sans-serif',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        pointerEvents: 'auto',
      }}
    >
      {/* Header row: label + arrows */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 10,
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.22em',
            textTransform: 'uppercase',
            color: textMuted,
          }}
        >
          Timeline
        </div>

        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            onClick={goBack}
            disabled={activeIndex === 0}
            style={{
              background: 'transparent',
              color: activeIndex === 0 ? textMuted : textPrimary,
              border: `1px solid ${panelBorder}`,
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              cursor: activeIndex === 0 ? 'default' : 'pointer',
              fontFamily: 'system-ui, sans-serif',
              opacity: activeIndex === 0 ? 0.5 : 1,
            }}
          >
            &larr;
          </button>
          <button
            type="button"
            onClick={goForward}
            disabled={activeIndex === events.length - 1}
            style={{
              background: 'transparent',
              color: activeIndex === events.length - 1 ? textMuted : textPrimary,
              border: `1px solid ${panelBorder}`,
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 11,
              fontWeight: 600,
              cursor: activeIndex === events.length - 1 ? 'default' : 'pointer',
              fontFamily: 'system-ui, sans-serif',
              opacity: activeIndex === events.length - 1 ? 0.5 : 1,
            }}
          >
            &rarr;
          </button>
        </div>
      </div>

      {/* Timeline track */}
      <div
        style={{
          position: 'relative',
          height: 32,
          marginBottom: 10,
        }}
      >
        {/* Background track line */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            right: 0,
            height: 2,
            background: trackBg,
            transform: 'translateY(-50%)',
            borderRadius: 1,
          }}
        />
        {/* Progress fill */}
        <div
          style={{
            position: 'absolute',
            top: '50%',
            left: 0,
            width: events.length > 1 ? `${(activeIndex / (events.length - 1)) * 100}%` : '0%',
            height: 2,
            background: accentColor,
            transform: 'translateY(-50%)',
            borderRadius: 1,
            transition: 'width 0.3s ease',
          }}
        />
        {/* Event dots */}
        {events.map((event, i) => {
          const leftPct = events.length > 1 ? (i / (events.length - 1)) * 100 : 50
          const isActive = i === activeIndex
          return (
            <button
              key={event.id}
              type="button"
              onClick={() => setActiveIndex(i)}
              title={event.label}
              style={{
                position: 'absolute',
                left: `${leftPct}%`,
                top: '50%',
                transform: 'translate(-50%, -50%)',
                width: isActive ? 14 : 10,
                height: isActive ? 14 : 10,
                borderRadius: '50%',
                background: isActive ? accentColor : trackBg,
                border: `2px solid ${isActive ? accentColor : (isLight ? 'rgba(0,0,0,0.2)' : 'rgba(255,255,255,0.2)')}`,
                cursor: 'pointer',
                padding: 0,
                transition: 'all 0.2s ease',
                zIndex: isActive ? 2 : 1,
              }}
            />
          )
        })}
      </div>

      {/* Current event info */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
        {currentEvent.year && (
          <span
            style={{
              fontFamily: 'ui-monospace, monospace',
              fontSize: 11,
              fontWeight: 700,
              color: accentColor,
              flexShrink: 0,
            }}
          >
            {currentEvent.year}
          </span>
        )}
        <span
          style={{
            fontWeight: 700,
            fontSize: 13,
          }}
        >
          {currentEvent.label}
        </span>
      </div>
      <div
        style={{
          fontSize: 12,
          color: textMuted,
          lineHeight: 1.4,
        }}
      >
        {currentEvent.description}
      </div>
    </div>
  )
}
