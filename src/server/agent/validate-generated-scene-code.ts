import React from 'react'
import type { RenderType, VisualizationRuntimeState } from '../../types/visualization'
import type { VisualizationValidationError } from '../../types/agent'

const DEFAULT_RUNTIME_STATE: VisualizationRuntimeState = {
  params: {},
  toggles: {},
  cues: [],
}

function validate3DSceneCode(
  sceneCode: string,
): { ok: true } | { ok: false; error: VisualizationValidationError } {
  const checks = {
    hasPointerInteraction:
      sceneCode.includes('onClick') ||
      sceneCode.includes('onPointerDown') ||
      sceneCode.includes('onPointerMove') ||
      sceneCode.includes('onPointerOver'),
    hasAnimation:
      sceneCode.includes('helpers.useFrame') || sceneCode.includes('useFrame'),
    hasLocalState:
      sceneCode.includes('React.useState') || sceneCode.includes('useState('),
    hasUIOverlay:
      sceneCode.includes('helpers.ScreenOverlay') ||
      sceneCode.includes('ScreenOverlay') ||
      sceneCode.includes('helpers.Html') ||
      sceneCode.includes('Html') ||
      sceneCode.includes('<button') ||
      sceneCode.includes('<input'),
    hasMultipleBodies:
      sceneCode.includes('sphereGeometry') ||
      sceneCode.includes('boxGeometry') ||
      sceneCode.includes('torusGeometry'),
  }

  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)

  if (failedChecks.length > 1) {
    return {
      ok: false,
      error: {
        phase: 'render',
        message:
          'Generated code is too basic. It must include richer interaction and UI behavior.',
        details: [
          'Add pointer interactions (onClick/onPointer*).',
          'Add continuous animation with helpers.useFrame.',
          'Add local interactive state with React.useState.',
          'Render controls/legend in fixed screen space using helpers.ScreenOverlay.',
          `Missing checks: ${failedChecks.join(', ')}`,
        ],
      },
    }
  }

  try {
    const mockReact = {
      Fragment: Symbol.for('react.fragment'),
      createElement: (
        type: unknown,
        props: Record<string, unknown> | null,
        ...children: unknown[]
      ) => ({ type, props: props ?? {}, children }),
      useState: <T,>(initial: T) => [initial, (_next: T) => undefined] as const,
      useMemo: <T,>(factory: () => T) => factory(),
      useRef: <T,>(value: T) => ({ current: value }),
      useEffect: () => undefined,
      useCallback: <T extends (...args: any[]) => any>(fn: T) => fn,
    }

    const fn = new Function(
      'React',
      'runtimeState',
      'helpers',
      sceneCode,
    ) as (
      react: typeof React,
      runtimeState: VisualizationRuntimeState,
      helpers: {
        useFrame: (callback: (state: unknown, delta: number) => void) => void
        Html: (props: unknown) => unknown
        ScreenOverlay: (props: unknown) => unknown
      },
    ) => unknown

    const result = fn(mockReact as unknown as typeof React, DEFAULT_RUNTIME_STATE, {
      useFrame: () => undefined,
      Html: () => null,
      ScreenOverlay: () => null,
    })

    const element = typeof result === 'function' ? result() : result

    if (typeof element === 'undefined' || element === null) {
      return {
        ok: false,
        error: {
          phase: 'render',
          message:
            'Generated code must return a renderable node. Return React.createElement(...)',
        },
      }
    }

    return { ok: true }
  } catch (error) {
    const rawMessage =
      error instanceof Error ? error.message : 'Generated scene code failed validation'

    // Add a helpful hint when the model uses the wrong parameter pattern
    const isRuntimeError =
      rawMessage.includes('runtime is not defined') ||
      rawMessage.includes("Cannot read properties of undefined (reading 'React')") ||
      rawMessage.includes("Cannot read properties of undefined (reading 'helpers')")
    const hint = isRuntimeError
      ? ' — The code must NOT wrap in a function(runtime) or function(props). React, runtimeState, and helpers are already in scope as top-level parameters. Define an inner component function and return it: function Scene() { ... } return Scene;'
      : ''

    return {
      ok: false,
      error: {
        phase: 'render',
        message: rawMessage + hint,
      },
    }
  }
}

function validate2DCanvasCode(
  sceneCode: string,
): { ok: true } | { ok: false; error: VisualizationValidationError } {
  const checks = {
    hasDrawingCalls:
      sceneCode.includes('ctx.') ||
      sceneCode.includes('beginPath') ||
      sceneCode.includes('fillRect') ||
      sceneCode.includes('strokeRect'),
    hasAnimation:
      sceneCode.includes('time') || sceneCode.includes('Math.sin') || sceneCode.includes('Math.cos'),
    usesCanvasDimensions:
      sceneCode.includes('canvas.width') || sceneCode.includes('canvas.height'),
  }

  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => name)

  // Require at least 2/3 checks to pass
  if (failedChecks.length > 1) {
    return {
      ok: false,
      error: {
        phase: 'render',
        message:
          'Generated 2D canvas code is too basic. It must use ctx drawing calls and respond to canvas dimensions.',
        details: [
          'Use ctx drawing methods (beginPath, arc, lineTo, fillRect, etc.).',
          'Include animation using the time parameter.',
          'Use canvas.width and canvas.height for responsive sizing.',
          `Missing checks: ${failedChecks.join(', ')}`,
        ],
      },
    }
  }

  // Dry-run the code to check for syntax errors
  try {
    new Function('ctx', 'canvas', 'time', 'React', 'runtimeState', sceneCode)
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: {
        phase: 'render',
        message:
          error instanceof Error
            ? error.message
            : 'Generated 2D canvas code failed validation',
      },
    }
  }
}

export function validateGeneratedSceneCode(
  sceneCode: string,
  renderType: RenderType = '3D_WEBGL',
): { ok: true } | { ok: false; error: VisualizationValidationError } {
  if (renderType === '2D_CANVAS') {
    return validate2DCanvasCode(sceneCode)
  }
  return validate3DSceneCode(sceneCode)
}
