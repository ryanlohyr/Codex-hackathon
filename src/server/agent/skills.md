# V4 Code Generation Skills

These are the capabilities available to the v4 visualization code generation agent.

## Core Code Editing Skills

### find_and_replace
Replace exact substrings in the current code. Must match exactly one location.
- **Skill Level**: Essential
- **Use Cases**: Adding new code, modifying existing sections, fixing syntax
- **Constraint**: old_string must be unique in the file

### view_range
Inspect specific sections of code (max 80 lines per call).
- **Skill Level**: Essential
- **Use Cases**: Understanding current code structure before editing
- **Constraint**: Must view target section before calling find_and_replace

### search_code
Find patterns in code without viewing large ranges.
- **Skill Level**: Essential
- **Use Cases**: Locating insertion points, finding specific function calls
- **Returns**: Matching lines with 2-line context

## Checklist Management Skills

### markChecklistItemDone
Mark implementation tasks as complete.
- **Skill Level**: Essential
- **Use Cases**: Tracking progress through implementation checklist
- **Trigger**: After fully implementing each checklist item

## Template & Boilerplate Skills

### insert_boilerplate
Insert predefined scene templates (3D WebGL or 2D Canvas).
- **Skill Level**: Advanced
- **Use Cases**: Starting with known-good templates, then customizing
- **Modes**:
  - `replace_if_empty`: Only insert if code is empty (default)
  - `replace_all`: Replace all current code
  - `append`: Add to existing code

## React Component Skills (3D_WEBGL Only)

### Scene Function Structure
Create the outer Scene function that returns all visual elements.
- React.createElement with React.Fragment as root
- All visual elements as children of the Fragment
- Proper scoping of hooks (useFrame, effects, etc.)

### R3F Element Creation
Use React.createElement with string tags for Three.js components.
- Valid tags: "mesh", "sphereGeometry", "meshStandardMaterial", "canvas", "group", etc.
- NO direct THREE.* usage
- Use helper utilities from the scope

## Data & Variable Skills

### State Management
Work with runtimeState for runtime variables and slider values.
- **Skill Level**: Advanced
- **Use Cases**: Accessing interactive slider values, storing computed data

### Helper Utilities
Access pre-defined helpers from the scope:
- `useFrame`: Animation loop integration
- `ScreenOverlay`: UI overlay component
- `InfoPoint`: Educational annotation system

## Syntax & Structural Skills

### Vector & Color Handling
- Vectors: Use plain arrays `[x, y, z]` instead of THREE.Vector3
- Colors: Use hex strings `"#ff0000"` instead of THREE.Color

### Function Body Code
Write code that executes inside a function body with:
- React, runtimeState, and helpers already in scope
- NO imports needed (pre-provided)
- Return a React component or element

## Progress Disclosure

These skills are revealed as the v4 agent completes checklist items and demonstrates capability:

1. **Initial**: find_and_replace, view_range, search_code, markChecklistItemDone
2. **After first item**: Scene function structure, R3F elements
3. **After third item**: State management, helper utilities
4. **Advanced**: insert_boilerplate (for complex visualizations)

The model learns which skills to apply based on the current checklist items and code structure.
