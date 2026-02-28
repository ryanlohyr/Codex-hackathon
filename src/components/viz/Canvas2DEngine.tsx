import { useCallback, useEffect, useRef, useState } from 'react'
import type { VisualizationConfig, VisualizationRuntimeState } from '../../types/visualization'

type Canvas2DEngineProps = {
  config: VisualizationConfig
  runtimeState: VisualizationRuntimeState
}

/** Hand-drawn aesthetic defaults applied to the canvas context each frame. */
function applyHandDrawnDefaults(ctx: CanvasRenderingContext2D) {
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.lineWidth = 2.5
  ctx.font = '16px "Comic Neue", "Comic Sans MS", "Caveat", cursive, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
}

/**
 * Demo drawing function: animated sine wave that flows across the screen.
 * Used as a fallback when no generatedSceneCode is provided.
 */
function drawSineWaveDemo(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  time: number,
) {
  const { width, height } = canvas
  const centerY = height / 2
  const amplitude = height * 0.2
  const frequency = 0.02
  const speed = 2

  // Background grid (hand-drawn style)
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.15)'
  ctx.lineWidth = 1
  const gridSpacing = 40
  for (let x = 0; x < width; x += gridSpacing) {
    ctx.beginPath()
    ctx.moveTo(x, 0)
    ctx.lineTo(x, height)
    ctx.stroke()
  }
  for (let y = 0; y < height; y += gridSpacing) {
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.lineTo(width, y)
    ctx.stroke()
  }

  // Axis lines
  ctx.strokeStyle = 'rgba(148, 163, 184, 0.4)'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(0, centerY)
  ctx.lineTo(width, centerY)
  ctx.stroke()

  // Primary sine wave
  ctx.strokeStyle = '#38bdf8'
  ctx.lineWidth = 3
  ctx.beginPath()
  for (let x = 0; x < width; x += 2) {
    const y = centerY + Math.sin(x * frequency + time * speed) * amplitude
    if (x === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()

  // Secondary cosine wave (offset)
  ctx.strokeStyle = '#a78bfa'
  ctx.lineWidth = 2.5
  ctx.beginPath()
  for (let x = 0; x < width; x += 2) {
    const y = centerY + Math.cos(x * frequency + time * speed) * amplitude * 0.7
    if (x === 0) {
      ctx.moveTo(x, y)
    } else {
      ctx.lineTo(x, y)
    }
  }
  ctx.stroke()

  // Pulsing dot on the primary wave at center
  const dotX = width / 2
  const dotY = centerY + Math.sin(dotX * frequency + time * speed) * amplitude
  const pulse = 4 + Math.sin(time * 4) * 2
  ctx.fillStyle = '#38bdf8'
  ctx.beginPath()
  ctx.arc(dotX, dotY, pulse, 0, Math.PI * 2)
  ctx.fill()

  // Labels
  ctx.fillStyle = '#94a3b8'
  ctx.font = '14px "Comic Neue", "Comic Sans MS", cursive, sans-serif'
  ctx.fillText('sin(x)', 20, centerY - amplitude - 16)
  ctx.fillStyle = '#a78bfa'
  ctx.fillText('cos(x)', 20, centerY + amplitude + 24)

  // Title
  ctx.fillStyle = '#e2e8f0'
  ctx.font = '18px "Comic Neue", "Comic Sans MS", cursive, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('2D Canvas Engine', width / 2, 30)
  ctx.textAlign = 'start'
}

/**
 * Canvas2DEngine renders 2D visualizations using HTML5 Canvas.
 *
 * If `config.generatedSceneCode` is provided, it compiles and runs that code
 * as a per-frame drawing function: (ctx, canvas, time, React, runtimeState) => void.
 *
 * Otherwise, it renders a built-in animated sine wave demo.
 */
export function Canvas2DEngine({ config, runtimeState }: Canvas2DEngineProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const animationRef = useRef<number>(0)
  const startTimeRef = useRef<number>(0)
  const [error, setError] = useState<string | null>(null)

  // Pointer tracking refs — updated by DOM events, read each frame
  const pointerRef = useRef({ x: 0, y: 0, down: false, clicked: false })

  type DrawFn = (
    ctx: CanvasRenderingContext2D,
    canvas: HTMLCanvasElement,
    time: number,
    react: null,
    state: VisualizationRuntimeState,
  ) => void

  const compiledDrawFn = useCallback((): DrawFn | null => {
    if (!config.generatedSceneCode) return null

    try {
      const fn = new Function(
        'ctx',
        'canvas',
        'time',
        'React',
        'runtimeState',
        config.generatedSceneCode,
      ) as (...args: Parameters<DrawFn>) => unknown

      // The generated code may either:
      // 1. Draw directly in the function body (correct), or
      // 2. Define an inner function and return it (e.g. `function render(...){...} return render;`)
      // Handle both cases by checking the return value on first call.
      let resolved: DrawFn | null = null
      const wrapper: DrawFn = (ctx, canvas, time, react, state) => {
        if (resolved) {
          resolved(ctx, canvas, time, react, state)
          return
        }
        const result = fn(ctx, canvas, time, react, state)
        if (typeof result === 'function') {
          // Code returned a function instead of drawing — call it now and use it going forward
          resolved = result as DrawFn
          resolved(ctx, canvas, time, react, state)
        }
        // Otherwise the code drew directly, which is fine — keep using fn
      }

      return wrapper
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compile 2D scene code')
      return null
    }
  }, [config.generatedSceneCode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const drawFn = compiledDrawFn()
    startTimeRef.current = performance.now()

    const resizeCanvas = () => {
      const dpr = window.devicePixelRatio || 1
      const rect = canvas.getBoundingClientRect()
      canvas.width = rect.width * dpr
      canvas.height = rect.height * dpr
      ctx.scale(dpr, dpr)
    }

    resizeCanvas()

    const resizeObserver = new ResizeObserver(() => {
      resizeCanvas()
    })
    resizeObserver.observe(canvas)

    // --- Pointer event listeners ---
    const ptr = pointerRef.current
    const toLogical = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    }

    const onPointerMove = (e: MouseEvent) => {
      const { x, y } = toLogical(e)
      ptr.x = x
      ptr.y = y
    }
    const onPointerDown = (e: MouseEvent) => {
      const { x, y } = toLogical(e)
      ptr.x = x
      ptr.y = y
      ptr.down = true
    }
    const onPointerUp = () => {
      ptr.down = false
    }
    const onClick = (e: MouseEvent) => {
      const { x, y } = toLogical(e)
      ptr.x = x
      ptr.y = y
      ptr.clicked = true
    }

    canvas.addEventListener('mousemove', onPointerMove)
    canvas.addEventListener('mousedown', onPointerDown)
    canvas.addEventListener('mouseup', onPointerUp)
    canvas.addEventListener('click', onClick)

    const animate = () => {
      const elapsed = (performance.now() - startTimeRef.current) / 1000
      const rect = canvas.getBoundingClientRect()

      // Inject pointer state so generated code can read runtimeState.pointer
      ;(runtimeState as Record<string, unknown>).pointer = {
        x: ptr.x,
        y: ptr.y,
        down: ptr.down,
        clicked: ptr.clicked,
      }

      // Clear the canvas
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.restore()

      // Fill background based on theme
      ctx.fillStyle = config.theme === 'light' ? '#faf8f5' : '#020617'
      ctx.fillRect(0, 0, rect.width, rect.height)

      // Apply hand-drawn defaults
      applyHandDrawnDefaults(ctx)

      // Provide CSS/logical dimensions so generated code doesn't use the
      // DPR-scaled physical pixel size (which would draw everything 2x too large).
      const logicalCanvas = Object.create(canvas, {
        width: { value: rect.width },
        height: { value: rect.height },
      }) as HTMLCanvasElement

      if (drawFn) {
        try {
          drawFn(ctx, logicalCanvas, elapsed, null, runtimeState)
          if (error) setError(null)
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Runtime error in 2D scene code')
          // Fall through to demo on error
          drawSineWaveDemo(ctx, logicalCanvas, elapsed)
        }
      } else if (!error) {
        drawSineWaveDemo(ctx, logicalCanvas, elapsed)
      }

      // Reset single-frame click flag after the draw call has consumed it
      ptr.clicked = false

      animationRef.current = requestAnimationFrame(animate)
    }

    animationRef.current = requestAnimationFrame(animate)

    return () => {
      cancelAnimationFrame(animationRef.current)
      resizeObserver.disconnect()
      canvas.removeEventListener('mousemove', onPointerMove)
      canvas.removeEventListener('mousedown', onPointerDown)
      canvas.removeEventListener('mouseup', onPointerUp)
      canvas.removeEventListener('click', onClick)
    }
  }, [compiledDrawFn, runtimeState, error])

  return (
    <div className="relative h-full w-full">
      <canvas
        ref={canvasRef}
        className="h-full w-full"
        style={{ display: 'block' }}
      />

      {error && (
        <div className="absolute bottom-4 left-4 right-4 rounded-xl border border-rose-500/40 bg-slate-900/90 px-4 py-3 text-sm text-rose-200 backdrop-blur">
          <p className="font-semibold">2D Canvas Error</p>
          <p className="mt-1 text-xs text-rose-300">{error}</p>
        </div>
      )}
    </div>
  )
}
