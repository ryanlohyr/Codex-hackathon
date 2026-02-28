import { useState, useCallback } from 'react'
import type {
  VisualizationControls,
  VisualizationTheme,
  VisualizationRuntimeState,
} from '../../types/visualization'

type RuntimeControlPanelProps = {
  controls: VisualizationControls
  theme?: VisualizationTheme
  runtimeState: VisualizationRuntimeState
}

export function RuntimeControlPanel({
  controls,
  theme,
  runtimeState,
}: RuntimeControlPanelProps) {
  const [, setRenderTick] = useState(0)
  const forceRender = useCallback(() => setRenderTick((t) => t + 1), [])

  const isLight = theme === 'light'

  const panelBg = isLight ? 'rgba(250, 245, 235, 0.92)' : 'rgba(15, 23, 42, 0.85)'
  const panelBorder = isLight ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.12)'
  const textPrimary = isLight ? '#1e293b' : '#e2e8f0'
  const textMuted = isLight ? '#64748b' : '#94a3b8'
  const accentColor = isLight ? '#0891b2' : '#f59e0b'

  // Ensure defaults are populated on first render
  for (const slider of controls.sliders) {
    runtimeState.params[slider.key] ??= slider.defaultValue
  }
  for (const toggle of controls.toggles) {
    runtimeState.toggles[toggle.key] ??= toggle.defaultValue
  }

  const handleSliderChange = useCallback(
    (key: string, value: number) => {
      runtimeState.params[key] = value
      forceRender()
    },
    [runtimeState, forceRender],
  )

  const handleToggle = useCallback(
    (key: string) => {
      runtimeState.toggles[key] = !runtimeState.toggles[key]
      forceRender()
    },
    [runtimeState, forceRender],
  )

  const handleReset = useCallback(() => {
    for (const slider of controls.sliders) {
      runtimeState.params[slider.key] = slider.defaultValue
    }
    for (const toggle of controls.toggles) {
      runtimeState.toggles[toggle.key] = toggle.defaultValue
    }
    forceRender()
  }, [controls, runtimeState, forceRender])

  return (
    <div
      style={{
        position: 'absolute',
        top: 16,
        left: 16,
        width: 320,
        zIndex: 20,
        background: panelBg,
        border: `1px solid ${panelBorder}`,
        borderRadius: 12,
        padding: 16,
        color: textPrimary,
        fontFamily: 'system-ui, sans-serif',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        pointerEvents: 'auto',
      }}
    >
      {/* Panel title */}
      <div
        style={{
          fontSize: 10,
          letterSpacing: '0.22em',
          textTransform: 'uppercase',
          color: textMuted,
          marginBottom: 10,
        }}
      >
        {controls.title}
      </div>

      {/* Sliders */}
      {controls.sliders.map((slider) => {
        const value = runtimeState.params[slider.key] as number
        return (
          <div key={slider.key} style={{ marginBottom: 12 }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  letterSpacing: '0.15em',
                  textTransform: 'uppercase',
                  fontWeight: 600,
                  color: textPrimary,
                }}
              >
                {slider.label}
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontFamily: 'ui-monospace, monospace',
                  fontWeight: 700,
                  color: textPrimary,
                }}
              >
                {typeof value === 'number' ? value.toFixed(2) : String(value)}
                {slider.unit ? ` ${slider.unit}` : ''}
              </div>
            </div>
            <input
              type="range"
              min={slider.min}
              max={slider.max}
              step={slider.step}
              value={value}
              onChange={(e) =>
                handleSliderChange(slider.key, parseFloat(e.target.value))
              }
              style={{ width: '100%', accentColor }}
            />
          </div>
        )
      })}

      {/* Toggle buttons + Reset */}
      <div
        style={{
          display: 'flex',
          gap: 10,
          flexWrap: 'wrap',
          marginTop: 10,
        }}
      >
        {controls.toggles.map((toggle) => {
          const active = runtimeState.toggles[toggle.key]
          return (
            <button
              key={toggle.key}
              type="button"
              onClick={() => handleToggle(toggle.key)}
              style={{
                background: active ? accentColor : 'transparent',
                color: active ? (isLight ? '#fff' : '#0b1220') : textPrimary,
                border: `1px solid ${panelBorder}`,
                borderRadius: 6,
                padding: '6px 14px',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.1em',
                textTransform: 'uppercase',
                cursor: 'pointer',
                fontFamily: 'system-ui, sans-serif',
              }}
            >
              {toggle.label}
            </button>
          )
        })}

        <button
          type="button"
          onClick={handleReset}
          style={{
            background: 'transparent',
            color: textPrimary,
            border: `1px solid ${panelBorder}`,
            borderRadius: 6,
            padding: '6px 14px',
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          Reset Defaults
        </button>
      </div>
    </div>
  )
}
