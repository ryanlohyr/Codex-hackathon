# Plan: Extract UI Boilerplate from Generated Code into Runtime

## Context

The code-generation agent (gpt-5.2) currently generates **everything** — 3D scene objects, animation logic, AND all UI chrome (left control panel with sliders/buttons, right scaffolded steps panel, styling helpers, forceRender mechanics). This causes:

1. **Bugs that are hard to fix at scale**: Stale closures in `useFrame` (React state captured once, never updated), controlled inputs without re-renders (sliders snap back). Every new visualization can have these bugs.
2. **~200-300 wasted lines/tokens** of identical boilerplate per visualization
3. **Inconsistent styling** between visualizations
4. **Layout collisions** with chatbox (bottom-right) and "Back to mindmap" button (bottom-left)

**Solution**: Move the control panels into the runtime. The generated code only produces the 3D scene + InfoPoint placements. The runtime renders panels from structured config data that's already available from the blueprint.

## Files to Modify

| File | Change |
|------|--------|
| `src/types/visualization.ts` | Add `SliderDef`, `ToggleDef`, `ScaffoldStep`, `VisualizationControls` types; add `controls?` and `scaffoldedSteps?` to `VisualizationConfig` |
| `src/components/viz/VisualizationCanvas.tsx` | Import and render new `RuntimeControlPanel` and `RuntimeStepsPanel` when `config.controls` exists |
| `src/components/viz/RuntimeControlPanel.tsx` | **New file** — left panel: sliders, toggle buttons, pause/reset |
| `src/components/viz/RuntimeStepsPanel.tsx` | **New file** — right panel: scaffolded steps with condition evaluation |
| `src/server/agent/prompts.ts` | Update `WEBGL_3D_RULES` and `LEARNING_RULES` to tell agent NOT to generate panels when runtime handles them; add new rules for the simplified contract |
| `src/server/agent/create-visualization-with-repair.ts` | Update `generateVisualizationMetadata()` to extract `controls` and `scaffoldedSteps` from blueprint |
| `src/server/agent/validate-generated-scene-code.ts` | Relax `hasUIOverlay` check when runtime panels are enabled |

## Step 1: New Types (`src/types/visualization.ts`)

Add after the existing `VisualizationConfig` type:

```ts
export type SliderDef = {
  key: string          // camelCase param key, e.g. "blackHoleMass"
  label: string        // display label, e.g. "Black Hole Mass"
  min: number
  max: number
  step: number
  defaultValue: number
  unit?: string        // optional unit, e.g. "kg"
}

export type ToggleDef = {
  key: string          // maps to runtimeState.toggles[key]
  label: string        // e.g. "Pause", "Infall Tracker"
  defaultValue: boolean
}

export type ScaffoldStep = {
  instruction: string  // what student should do
  concept: string      // what they learn
  condition: string    // expression evaluated against runtimeState.params, e.g. "mass > 50"
}

export type VisualizationControls = {
  title: string              // panel title, e.g. "BLACK HOLE CONTROLS"
  sliders: SliderDef[]
  toggles: ToggleDef[]
}
```

Add to `VisualizationConfig`:

```ts
export type VisualizationConfig = {
  // ... existing fields ...
  controls?: VisualizationControls
  scaffoldedSteps?: ScaffoldStep[]
}
```

## Step 2: RuntimeControlPanel (`src/components/viz/RuntimeControlPanel.tsx`)

New component renders the **left panel** — positioned `top-16 left-16`, max-width 320px.

Responsibilities:
- Renders sliders from `config.controls.sliders` — each slider reads/writes `runtimeState.params[key]`
- Renders toggle buttons from `config.controls.toggles` — reads/writes `runtimeState.toggles[key]`
- Has a "Reset Defaults" button that resets all params/toggles to their `defaultValue`
- Uses internal `useState` tick for forcing re-renders when sliders change (fixing the controlled input bug permanently)
- All styling matches the design system (dark/light theme from `config.theme`)
- Sets `pointerEvents: "auto"` on interactive elements so clicks don't pass through to the 3D scene

Key design decisions:
- Reads `runtimeState.params[key]` directly (not React state) — no stale closure possible
- On slider `onChange`: mutates `runtimeState.params[key]` AND bumps render tick
- On toggle click: mutates `runtimeState.toggles[key]` AND bumps render tick
- Panel is rendered as a regular React component in the DOM overlay (NOT inside R3F Canvas), avoiding all the ScreenOverlay/Html complexity

## Step 3: RuntimeStepsPanel (`src/components/viz/RuntimeStepsPanel.tsx`)

New component renders the **right panel** — positioned `top-16 right-16`, max-width 360px.

Responsibilities:
- Renders scaffolded steps from `config.scaffoldedSteps`
- Tracks current step index in local state (and syncs to `runtimeState.params.__stepIndex` so generated code can read it if needed)
- Evaluates each step's `condition` string against `runtimeState.params` using a safe expression parser
- Shows instruction (bold), concept (italic serif), and condition status (green/red)
- Navigation buttons (prev/next)
- Uses a `setInterval` (~500ms) to poll `runtimeState.params` and re-evaluate conditions, since params are mutated externally by the 3D scene's useFrame

Safe condition evaluator (simple expression parser):
- Parse simple expressions like `mass > 50`, `spin > 0.5 && accretionRate > 0.3`
- Support operators: `>`, `<`, `>=`, `<=`, `===`, `==`, `&&`, `||`
- Variable names resolve to `runtimeState.params[name]`
- No `eval()` or `new Function()` — pure parsing
- Tokenize into numbers, identifiers, and operators, then evaluate left-to-right with standard precedence

## Step 4: VisualizationCanvas Changes (`src/components/viz/VisualizationCanvas.tsx`)

Render the new panels **outside** the `<Canvas>` element (as sibling DOM elements), so they're regular HTML with normal React event handling — no drei `Html` or `ScreenOverlay` needed.

```tsx
<div className="relative h-full w-full">
  <Canvas ...>
    {/* 3D scene only — generated code still gets ScreenOverlay for custom overlays */}
  </Canvas>

  {/* Runtime panels — rendered when config.controls exists */}
  {config.controls && (
    <RuntimeControlPanel
      controls={config.controls}
      theme={config.theme}
      runtimeState={runtimeState}
    />
  )}
  {config.scaffoldedSteps && (
    <RuntimeStepsPanel
      steps={config.scaffoldedSteps}
      theme={config.theme}
      runtimeState={runtimeState}
    />
  )}

  {/* Existing: selectedInfo overlay, contextLost overlay */}
</div>
```

This completely sidesteps the ScreenOverlay/Html pointer-event issues since these are normal DOM elements.

**ScreenOverlay stays available**: The `helpers.ScreenOverlay` is still passed to generated code so it can render custom scene-specific overlays (e.g. inset escape-speed graphs, inline legends). The runtime just takes over the standard control/steps panels.

## Step 5: Prompt Changes (`src/server/agent/prompts.ts`)

### Update WEBGL_3D_RULES

Add a section at the top:

```
=== RUNTIME UI PANELS (the engine renders control panels for you) ===
The engine automatically renders:
- A LEFT control panel with sliders and toggle buttons (from the blueprint's Simulation Variables)
- A RIGHT scaffolded steps panel (from the blueprint's Scaffolding Steps)

You do NOT need to create these panels. Do NOT generate:
- ScreenOverlay elements for control panels or step panels
- sliderRow() helper functions
- forceRender() / renderTick mechanisms
- uiPanelBase() / titleStyle() / buttonStyle() styling functions
- Scaffolded steps arrays or navigation logic

Your code ONLY needs to:
1. Initialize runtimeState.params defaults (runtimeState.params.mass ??= 10)
2. Define the 3D scene (meshes, lights, particles, materials)
3. Animate via helpers.useFrame — read values from runtimeState.params and runtimeState.toggles
4. Place InfoPoint elements for educational labels
5. Return the Scene component

The engine reads runtimeState.params and runtimeState.toggles for slider/toggle values.
Use runtimeState.toggles.isPaused to check if animation is paused.
=== END RUNTIME UI PANELS ===
```

### Update LEARNING_RULES

Remove the scaffolded steps panel instructions (the runtime handles it). Keep the InfoPoint section since those are 3D-positioned and scene-specific.

### Update DESIGN_SYSTEM_RULES

Simplify — remove the panel styling rules since the runtime handles panel rendering. Keep palette/typography rules for InfoPoint styling.

## Step 6: Metadata Extraction Changes

In `create-visualization-with-repair.ts`, update `generateVisualizationMetadata()` to also extract:

```ts
{
  // existing: type, theme, title, summary, params
  controls: {
    title: string,
    sliders: SliderDef[],
    toggles: ToggleDef[]
  },
  scaffoldedSteps: ScaffoldStep[]
}
```

The blueprint already has Simulation Variables as a markdown table and Scaffolding Steps as a numbered list — the LLM just needs to extract them into structured form. Add these to the generateObject schema.

## Step 7: Backward Compatibility

- **Old visualizations** (no `config.controls`): Work exactly as before. Generated code contains its own ScreenOverlay panels. No runtime panels rendered.
- **New visualizations** (has `config.controls`): Runtime renders panels. Generated code is simpler (scene-only).
- Detection: `if (config.controls)` — simple presence check.
- No migration needed for existing saved data.

## Step 8: What Bugs This Fixes Permanently

1. **Stale closures**: Generated code no longer has React `useState` for toggles. It only reads `runtimeState.params` and `runtimeState.toggles` (persistent mutable objects) in `useFrame`. No closure staleness possible.
2. **Controlled input snapping**: Runtime's `RuntimeControlPanel` handles slider rendering with proper `setState` + `runtimeState.params` mutation. The fix lives in one place, not regenerated every time.
3. **Panel layout collisions**: Runtime panels have hardcoded safe positioning that avoids chatbox and back-to-mindmap button.
4. **Inconsistent styling**: One implementation of panel styling in the runtime, not LLM-generated each time.

## Verification

1. Create a new visualization and verify:
   - Left panel renders with correct sliders from blueprint
   - Sliders move smoothly and affect the 3D scene
   - Toggle buttons work and affect useFrame behavior
   - Right panel shows scaffolded steps with condition evaluation
   - Step navigation works
   - Panels don't overlap chatbox or back-to-mindmap button
2. Load an existing visualization (no `config.controls`) and verify it still works with the old ScreenOverlay-based panels
3. Run the existing build/type-check to verify no regressions

## Step 9: Reusable "Real Globe" Boilerplate

Add a reusable globe scaffold that the code model can adapt whenever the topic is Earth / world / geography. This keeps globe outputs consistent and reduces one-off scene bugs.

```js
function Scene() {
  var earthRef = React.useRef(null);
  var cloudsRef = React.useRef(null);
  var [cloudData] = React.useState(function () {
    var count = 1800;
    var positions = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var u = Math.random();
      var v = Math.random();
      var theta = 2 * Math.PI * u;
      var phi = Math.acos(2 * v - 1);
      var r = 2.08 + (Math.random() - 0.5) * 0.02;
      positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = r * Math.cos(phi);
      positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return { count: count, positions: positions };
  });

  function latLonToXYZ(lat, lon, radius) {
    var phi = (90 - lat) * (Math.PI / 180);
    var theta = (lon + 180) * (Math.PI / 180);
    var x = -(radius * Math.sin(phi) * Math.cos(theta));
    var y = radius * Math.cos(phi);
    var z = radius * Math.sin(phi) * Math.sin(theta);
    return [x, y, z];
  }

  helpers.useFrame(function (_, delta) {
    if (runtimeState.toggles.isPaused) return;
    if (earthRef.current) earthRef.current.rotation.y += delta * 0.12;
    if (cloudsRef.current) cloudsRef.current.rotation.y += delta * 0.16;
  });

  return React.createElement(
    "group",
    null,
    React.createElement("ambientLight", { intensity: 0.35 }),
    React.createElement("directionalLight", { position: [5, 3, 4], intensity: 1.2, color: "#fff4d6" }),
    React.createElement(
      "group",
      { ref: earthRef },
      React.createElement(
        "mesh",
        null,
        React.createElement("sphereGeometry", { args: [2, 96, 96] }),
        React.createElement("meshStandardMaterial", {
          color: "#2a6fa8",
          roughness: 0.86,
          metalness: 0.05,
        })
      ),
      React.createElement(
        "mesh",
        { scale: [1.03, 1.03, 1.03] },
        React.createElement("sphereGeometry", { args: [2, 64, 64] }),
        React.createElement("meshStandardMaterial", {
          color: "#9bd7ff",
          transparent: true,
          opacity: 0.14,
          roughness: 0.2,
          metalness: 0,
        })
      ),
      React.createElement(
        "points",
        { ref: cloudsRef },
        React.createElement(
          "bufferGeometry",
          null,
          React.createElement("bufferAttribute", {
            attach: "attributes-position",
            count: cloudData.count,
            array: cloudData.positions,
            itemSize: 3,
          })
        ),
        React.createElement("pointsMaterial", {
          color: "#ffffff",
          size: 0.03,
          transparent: true,
          opacity: 0.45,
          depthWrite: false,
        })
      )
    ),
    React.createElement(helpers.InfoPoint, {
      label: "EQUATOR",
      explanation: "The equator splits Earth into northern and southern hemispheres.",
      position: latLonToXYZ(0, 0, 2.35),
      color: "#f59e0b",
    }),
    React.createElement(helpers.InfoPoint, {
      label: "NORTH POLE",
      explanation: "Earth's axis points through the poles, causing seasonal light differences.",
      position: latLonToXYZ(85, 0, 2.35),
      color: "#7dd3fc",
    }),
    React.createElement(helpers.InfoPoint, {
      label: "PACIFIC BASIN",
      explanation: "The Pacific is Earth's largest ocean basin and heavily shapes climate circulation.",
      position: latLonToXYZ(10, -150, 2.35),
      color: "#38bdf8",
    })
  );
}
return Scene;
```

Notes:
- Keep globe radius around `1.8` to `2.4` so OrbitControls framing stays comfortable.
- Use `latLonToXYZ()` for all region labels to avoid manual coordinate mistakes.
- For stronger realism later, swap base material colors using palette values extracted from the blueprint.
