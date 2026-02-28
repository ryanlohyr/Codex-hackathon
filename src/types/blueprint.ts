import type { RenderType } from './visualization'

// ---------------------------------------------------------------------------
// InstructionalBlueprint — documentation type
// ---------------------------------------------------------------------------
// The Teacher model outputs a **markdown string** whose content should cover
// every field below. This type is NOT used at runtime for parsing — it exists
// so future contributors understand the expected blueprint shape.
// ---------------------------------------------------------------------------

export type VisualMode = '2d-canvas' | '3d-threejs'

export type SimulationVariable = {
  name: string
  label: string
  min: number
  max: number
  default: number
  unit?: string
}

export type ScaffoldingStep = {
  stepNumber: number
  instruction: string
  expectedConcept: string
  /** Logic expression using variable names, e.g. "mass > 50" */
  stateCondition: string
}

/** Reference type describing the structure the Teacher prompt should produce. */
export type InstructionalBlueprint = {
  visualMode: VisualMode
  learningGoal: string
  analogy: string
  simulationVariables: SimulationVariable[]
  scaffoldingSteps: ScaffoldingStep[]
}

/** Maps the Teacher's visual-mode string to the internal RenderType used by the Coder. */
export function visualModeToRenderType(mode: VisualMode): RenderType {
  return mode === '2d-canvas' ? '2D_CANVAS' : '3D_WEBGL'
}
