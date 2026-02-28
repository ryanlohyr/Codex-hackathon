import React, { useCallback, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { Html, OrbitControls, Stars, Text, useTexture } from '@react-three/drei'
import { EffectComposer, Bloom } from '@react-three/postprocessing'
import type { RootState } from '@react-three/fiber'
import { useFrame } from '@react-three/fiber'
import type { VisualizationConfig, VisualizationRuntimeState } from '../../types/visualization'
import { SolarSystemScene } from './scenes/SolarSystemScene'
import { RuntimeControlPanel } from './RuntimeControlPanel'
import { RuntimeStepsPanel } from './RuntimeStepsPanel'
import { RuntimeTimelinePanel } from './RuntimeTimelinePanel'

type VisualizationCanvasProps = {
  config: VisualizationConfig
  runtimeState: VisualizationRuntimeState
}

type InfoPointSelection = {
  label: string
  explanation: string
} | null

function GeneratedCodeScene({
  code,
  runtimeState,
  onSelectInfo,
  isLight,
}: {
  code: string
  runtimeState: VisualizationRuntimeState
  onSelectInfo: (info: InfoPointSelection) => void
  isLight: boolean
}) {
  const ScreenOverlay = useMemo(
    () =>
      function ScreenOverlay({
        children,
        style,
      }: {
        children?: React.ReactNode
        style?: React.CSSProperties
      }) {
        return (
          <Html
            fullscreen
            style={{
              pointerEvents: 'none',
            }}
          >
            {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions */}
            <div
              style={{
                position: 'absolute',
                inset: 0,
                pointerEvents: 'none',
                ...style,
              }}
              onPointerDown={(e) => e.stopPropagation()}
              onPointerMove={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onWheel={(e) => e.stopPropagation()}
            >
              {children}
            </div>
          </Html>
        )
      },
    [],
  )

  const InfoPoint = useMemo(
    () =>
      function InfoPoint({
        label,
        explanation,
        position,
        color,
      }: {
        label: string
        explanation: string
        position: [number, number, number]
        color?: string
      }) {
        const accentColor = color ?? (isLight ? '#0891b2' : '#67e8f9')
        return (
          <Html position={position} center>
            <div
              onClick={(e) => {
                e.stopPropagation()
                onSelectInfo({ label, explanation })
              }}
              style={{
                pointerEvents: 'auto',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontFamily: 'system-ui, sans-serif',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.15em',
                textTransform: 'uppercase' as const,
                color: accentColor,
                textShadow: isLight ? 'none' : '0 1px 4px rgba(0,0,0,0.7)',
                userSelect: 'none' as const,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  border: `1.5px solid ${accentColor}`,
                  flexShrink: 0,
                }}
              />
              {label}
            </div>
          </Html>
        )
      },
    [onSelectInfo, isLight],
  )

  const compiled = useMemo(() => {
    try {
      const fn = new Function(
        'React',
        'runtimeState',
        'helpers',
        code,
      ) as (
        react: typeof React,
        state: VisualizationRuntimeState,
        helpers: {
          useFrame: typeof useFrame
          useTexture: typeof useTexture
          Html: typeof Html
          ScreenOverlay: typeof ScreenOverlay
          InfoPoint: typeof InfoPoint
        },
      ) => React.ReactNode | React.ComponentType
      return { fn, error: null as string | null }
    } catch (error) {
      return {
        fn: null,
        error: error instanceof Error ? error.message : 'Failed to compile generated scene code',
      }
    }
  }, [code])

  // Memoize the Scene component so parent re-renders (e.g. selectedInfo state)
  // don't cause compiled.fn to re-execute and return a new function reference,
  // which would unmount/remount the entire 3D scene.
  const SceneComponent = useMemo(() => {
    if (!compiled.fn) return null
    try {
      const result = compiled.fn(React, runtimeState, {
        useFrame,
        useTexture,
        Html,
        ScreenOverlay,
        InfoPoint,
      })
      if (typeof result === 'function') return result as React.ComponentType
      return null
    } catch {
      return null
    }
  }, [compiled, runtimeState, ScreenOverlay, InfoPoint])

  if (compiled.error) {
    return (
      <Text color="#fecaca" fontSize={0.5} anchorX="center" anchorY="middle">
        {`Generated scene code error: ${compiled.error}`}
      </Text>
    )
  }

  if (SceneComponent) {
    return React.createElement(SceneComponent)
  }

  return (
    <Text color="#fecaca" fontSize={0.5} anchorX="center" anchorY="middle">
      Generated scene returned no renderable component
    </Text>
  )
}

export function VisualizationCanvas({ config, runtimeState }: VisualizationCanvasProps) {
  const [canvasKey, setCanvasKey] = useState(0)
  const [contextLost, setContextLost] = useState(false)
  const [safeMode, setSafeMode] = useState(false)
  const [selectedInfo, setSelectedInfo] = useState<InfoPointSelection>(null)
  const lossCountRef = useRef(0)

  const handleCreated = useCallback(({ gl }: RootState) => {
    const canvas = gl.domElement

    const onLost = (event: Event) => {
      event.preventDefault()
      setContextLost(true)
      lossCountRef.current += 1

      // Auto-recover a couple of times to avoid blocking the user.
      if (lossCountRef.current <= 2) {
        window.setTimeout(() => {
          setContextLost(false)
          setCanvasKey((value) => value + 1)
        }, 250)
      } else {
        setSafeMode(true)
      }
    }

    const onRestored = () => {
      setContextLost(false)
    }

    canvas.addEventListener('webglcontextlost', onLost, false)
    canvas.addEventListener('webglcontextrestored', onRestored, false)
  }, [])

  const remountCanvas = () => {
    setContextLost(false)
    setCanvasKey((value) => value + 1)
  }

  const cameraConfig = { position: [0, 3, 10] as [number, number, number], fov: 55 }
  const isLight = config.theme === 'light'
  const backgroundColor = isLight ? '#faf8f5' : '#020617'
  const minZoomDistance =
    typeof config.params.minZoomDistance === 'number' ? config.params.minZoomDistance : 3
  const maxZoomDistance =
    typeof config.params.maxZoomDistance === 'number' ? config.params.maxZoomDistance : 28

  return (
    <div className="relative h-full w-full">
      <Canvas
        key={canvasKey}
        dpr={safeMode ? [1, 1] : [1, 2]}
        camera={cameraConfig}
        gl={{
          antialias: !safeMode,
          powerPreference: safeMode ? 'low-power' : 'high-performance',
          alpha: false,
          stencil: false,
          depth: true,
          preserveDrawingBuffer: false,
        }}
        onCreated={handleCreated}
      >
        <color attach="background" args={[backgroundColor]} />
        {!safeMode && !isLight && <Stars radius={100} depth={30} count={180} factor={1.4} fade speed={0.12} />}
        <OrbitControls
          makeDefault
          enablePan
          enableZoom
          enableRotate
          minDistance={minZoomDistance}
          maxDistance={maxZoomDistance}
        />

        <React.Suspense fallback={null}>
          {config.generatedSceneCode ? (
            <GeneratedCodeScene
              code={config.generatedSceneCode}
              runtimeState={runtimeState}
              onSelectInfo={setSelectedInfo}
              isLight={isLight}
            />
          ) : config.type === 'solar-system' ? (
            <SolarSystemScene config={config} runtimeState={runtimeState} />
          ) : null}
        </React.Suspense>

        {!safeMode && (
          <EffectComposer>
            <Bloom
              intensity={0.35}
              luminanceThreshold={0.7}
              luminanceSmoothing={0.9}
              mipmapBlur
            />
          </EffectComposer>
        )}
      </Canvas>

      {config.controls && (
        <RuntimeControlPanel
          controls={config.controls}
          theme={config.theme}
          runtimeState={runtimeState}
        />
      )}
      {config.scaffoldedSteps && config.scaffoldedSteps.length > 0 && (
        <RuntimeStepsPanel
          steps={config.scaffoldedSteps}
          theme={config.theme}
          runtimeState={runtimeState}
        />
      )}
      {config.visualizationType === 'timeline' && config.timelineEvents && config.timelineEvents.length > 0 && (
        <RuntimeTimelinePanel
          events={config.timelineEvents}
          theme={config.theme}
          runtimeState={runtimeState}
        />
      )}

      {selectedInfo && (
        <div
          className="absolute bottom-16 left-1/2 z-30 max-w-md -translate-x-1/2"
          onClick={() => setSelectedInfo(null)}
        >
          <div
            className={
              isLight
                ? 'rounded-xl border border-black/10 bg-white/90 px-5 py-4 shadow-lg backdrop-blur'
                : 'rounded-xl border border-white/12 bg-slate-900/90 px-5 py-4 shadow-lg backdrop-blur'
            }
          >
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.22em] ${isLight ? 'text-cyan-700' : 'text-cyan-300'}`}
            >
              {selectedInfo.label}
            </p>
            <p className={`mt-1.5 text-sm leading-relaxed ${isLight ? 'text-slate-700' : 'text-slate-200'}`}>
              {selectedInfo.explanation}
            </p>
            <p className={`mt-2 text-[10px] ${isLight ? 'text-slate-400' : 'text-slate-500'}`}>
              Click to dismiss
            </p>
          </div>
        </div>
      )}

      {contextLost && (
        <div className="absolute inset-0 grid place-items-center bg-slate-950/90">
          <div className="rounded-xl border border-white/20 bg-slate-900/80 px-4 py-3 text-sm text-slate-100">
            <p>3D context was lost.</p>
            <button
              type="button"
              onClick={remountCanvas}
              className="mt-2 rounded-md bg-cyan-300 px-3 py-1.5 text-xs font-semibold text-slate-950"
            >
              Recover 3D View
            </button>
            {safeMode && (
              <p className="mt-2 text-xs text-slate-300">
                Safe mode is enabled (reduced GPU effects).
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
