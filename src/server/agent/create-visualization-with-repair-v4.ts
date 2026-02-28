import OpenAI from 'openai'
import type {
  FunctionTool,
  ResponseInputItem,
  ResponseFunctionToolCall,
} from 'openai/resources/responses/responses'
import type { VisualizationValidationError } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  id: string
  description: string
  done: boolean
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addLineNumbers(code: string): string {
  return code
    .split('\n')
    .map((line, i) => `${i + 1} | ${line}`)
    .join('\n')
}

function formatChecklist(items: ChecklistItem[]): string {
  return items
    .map((item) => `- [${item.done ? 'x' : ' '}] \`${item.id}\` — ${item.description}`)
    .join('\n')
}

// ---------------------------------------------------------------------------
// Patch parsing & application (COMMENTED OUT — using findAndReplace instead)
// ---------------------------------------------------------------------------

// type PatchHunk = {
//   oldLines: string[]
//   newLines: string[]
// }

// function parsePatch(patch: string): PatchHunk[] {
//   const hunks: PatchHunk[] = []
//   const rawHunks = patch.split(/^@@/m).filter((s) => s.trim().length > 0)

//   for (const raw of rawHunks) {
//     const lines = raw.split('\n')
//     const oldLines: string[] = []
//     const newLines: string[] = []

//     for (const line of lines) {
//       if (line.startsWith('-')) {
//         oldLines.push(line.slice(1))
//       } else if (line.startsWith('+')) {
//         newLines.push(line.slice(1))
//       } else if (line.startsWith(' ')) {
//         oldLines.push(line.slice(1))
//         newLines.push(line.slice(1))
//       }
//       // Lines that don't start with -, +, or space are ignored (e.g. hunk headers)
//     }

//     if (oldLines.length > 0 || newLines.length > 0) {
//       hunks.push({ oldLines, newLines })
//     }
//   }
//   return hunks
// }

// function applyPatch(
//   current: string,
//   patchStr: string,
// ): { ok: true; code: string } | { ok: false; error: string } {
//   const hunks = parsePatch(patchStr)
//   if (hunks.length === 0) {
//     return { ok: false, error: 'No valid hunks found in patch.' }
//   }

//   for (let h = 0; h < hunks.length; h++) {
//     const hunk = hunks[h]
//     const oldBlock = hunk.oldLines.join('\n')
//     const newBlock = hunk.newLines.join('\n')

//     // Pure insertion (no old lines to match)
//     if (oldBlock.length === 0) {
//       current = current.length === 0 ? newBlock : current + '\n' + newBlock
//       continue
//     }

//     const idx = current.indexOf(oldBlock)
//     if (idx === -1) {
//       return {
//         ok: false,
//         error: `Hunk ${h + 1}: could not find the context/removed lines in the current code. Make sure your context lines match exactly.`,
//       }
//     }

//     current = current.slice(0, idx) + newBlock + current.slice(idx + oldBlock.length)
//   }

//   return { ok: true, code: current }
// }

// ---------------------------------------------------------------------------
// Find and replace — simple exact-string replacement
// ---------------------------------------------------------------------------

function findAndReplace(
  current: string,
  oldStr: string,
  newStr: string,
): { ok: true; code: string } | { ok: false; error: string } {
  // Handle insert-new-file case: oldStr is empty
  if (oldStr.length === 0) {
    if (current.length === 0) {
      return { ok: true, code: newStr }
    }
    return { ok: false, error: 'old_string is empty but the file is not empty. Provide the exact text to replace.' }
  }

  const idx = current.indexOf(oldStr)
  if (idx === -1) {
    // Try to provide a helpful error with closest partial match
    const firstLine = oldStr.split('\n')[0]
    const lines = current.split('\n')
    const closestLine = lines.findIndex((l) => l.includes(firstLine.trim()))
    const hint = closestLine !== -1
      ? ` The first line of your old_string ("${firstLine.trim().substring(0, 60)}") was found near line ${closestLine + 1} but the full match failed. Check for whitespace or line differences.`
      : ` Could not find even the first line ("${firstLine.trim().substring(0, 60)}") in the current code.`
    return {
      ok: false,
      error: `Could not find the specified old_string in the current code.${hint} Use view_range or search_code to see the actual code before editing.`,
    }
  }

  // Check for multiple matches — require uniqueness
  const secondIdx = current.indexOf(oldStr, idx + 1)
  if (secondIdx !== -1) {
    return {
      ok: false,
      error: 'old_string matches multiple locations. Add more surrounding context lines to make the match unique.',
    }
  }

  const result = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length)
  return { ok: true, code: result }
}

// ---------------------------------------------------------------------------
// Skeleton generation — compact structural view for code state injection
// ---------------------------------------------------------------------------

const SKELETON_THRESHOLD = 200

function findClosingBrace(lines: string[], startIdx: number): number {
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) return i
      }
    }
  }
  return lines.length - 1
}

function findStatementEnd(lines: string[], startIdx: number): number {
  let depth = 0
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i]
    for (const ch of line) {
      if (ch === '{' || ch === '[' || ch === '(') depth++
      else if (ch === '}' || ch === ']' || ch === ')') depth--
    }
    if (depth <= 0 && line.trimEnd().endsWith(';')) return i
    if (i > startIdx && depth <= 0) return i
  }
  return lines.length - 1
}

function extractFragmentChildren(
  lines: string[],
  returnStart: number,
  returnEnd: number,
): Array<{ startLine: number; endLine: number; summary: string }> {
  const children: Array<{ startLine: number; endLine: number; summary: string }> = []

  let baseDepth = -1
  let parenDepth = 0
  let childrenStartLine = returnStart

  for (let k = returnStart; k <= returnEnd; k++) {
    const line = lines[k]
    if (/null\s*,/.test(line)) {
      for (let m = returnStart; m <= k; m++) {
        for (const ch of lines[m]) {
          if (ch === '(') parenDepth++
          else if (ch === ')') parenDepth--
        }
      }
      baseDepth = parenDepth
      childrenStartLine = k + 1
      break
    }
  }

  if (baseDepth === -1) return children

  let depth = baseDepth
  let childStart = -1
  let childTag = ''

  for (let k = childrenStartLine; k <= returnEnd; k++) {
    const line = lines[k]
    const trimmed = line.trim()

    if (depth === baseDepth && /React\.createElement\s*\(/.test(trimmed)) {
      if (childStart !== -1) {
        children.push({ startLine: childStart + 1, endLine: k, summary: childTag })
      }
      let tagMatch =
        trimmed.match(/React\.createElement\s*\(\s*["']([^"']+)["']/) ||
        trimmed.match(/React\.createElement\s*\(\s*(\w+)/)
      if (!tagMatch && k + 1 <= returnEnd) {
        const nextTrimmed = lines[k + 1].trim()
        tagMatch = nextTrimmed.match(/^["']([^"']+)["']/) || nextTrimmed.match(/^(\w+)/)
      }
      childTag = tagMatch
        ? `React.createElement("${tagMatch[1]}", ...)`
        : 'React.createElement(...)'
      childStart = k
    }

    if (depth === baseDepth && /\.map\s*\(\s*function/.test(trimmed) && childStart === -1) {
      const mapMatch = trimmed.match(/(\w+)\.map\s*\(/)
      childTag = mapMatch ? `${mapMatch[1]}.map(...)` : '.map(...)'
      childStart = k
    }

    for (const ch of line) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
    }

    if (depth === baseDepth && childStart !== -1 && k > childStart) {
      children.push({ startLine: childStart + 1, endLine: k + 1, summary: childTag })
      childStart = -1
      childTag = ''
    }
  }

  if (childStart !== -1) {
    children.push({ startLine: childStart + 1, endLine: returnEnd + 1, summary: childTag })
  }

  return children
}

function generateSkeleton(code: string): string {
  const lines = code.split('\n')
  const totalLines = lines.length
  const result: string[] = [`(${totalLines} total lines — use view_range to inspect sections)`]

  let i = 0
  while (i < totalLines) {
    const line = lines[i]
    const trimmed = line.trim()
    const ln = i + 1

    if (trimmed === '') {
      i++
      continue
    }

    // Top-level var/const
    if (/^(var|const|let)\s+\w+/.test(trimmed) && !trimmed.includes('function')) {
      const end = findStatementEnd(lines, i)
      if (end === i) {
        result.push(`[${ln}] ${trimmed.substring(0, 80)}`)
      } else {
        const name = trimmed.match(/^(?:var|const|let)\s+(\w+)/)?.[1] ?? 'declaration'
        result.push(`[${ln}-${end + 1}] ${name} declaration (${end - i + 1} lines)`)
      }
      i = end + 1
      continue
    }

    // function Scene() — recurse
    if (/^function\s+Scene\s*\(/.test(trimmed)) {
      const sceneEnd = findClosingBrace(lines, i)
      result.push(`[${ln}-${sceneEnd + 1}] function Scene() {`)

      let j = i + 1
      while (j < sceneEnd) {
        const innerLine = lines[j]
        const innerTrimmed = innerLine.trim()
        const innerLn = j + 1

        if (innerTrimmed === '') {
          j++
          continue
        }

        // Helpers destructuring
        if (
          /=\s*helpers\.\w+/.test(innerTrimmed) ||
          /const\s*\{.*\}\s*=\s*helpers/.test(innerTrimmed)
        ) {
          const groupStart = j
          while (j < sceneEnd && /=\s*helpers\.\w+/.test(lines[j].trim())) j++
          const count = j - groupStart
          if (count <= 1) {
            result.push(`  [${groupStart + 1}] ${innerTrimmed.substring(0, 80)}`)
            j = Math.max(j, groupStart + 1)
          } else {
            result.push(`  [${groupStart + 1}-${j}] helpers destructuring (${count} lines)`)
          }
          continue
        }

        // runtimeState.params
        if (/runtimeState\.params/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd && /runtimeState\.params/.test(lines[j].trim())) j++
          const count = j - groupStart
          result.push(
            `  [${groupStart + 1}-${j}] runtimeState.params initialization (${count} lines)`,
          )
          continue
        }

        // useState group
        if (/React\.useState|useState\(/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd && /React\.useState|useState\(/.test(lines[j].trim())) j++
          const count = j - groupStart
          if (count === 1) {
            result.push(`  [${groupStart + 1}] ${innerTrimmed.substring(0, 80)}`)
          } else {
            result.push(`  [${groupStart + 1}-${j}] useState declarations (${count} variables)`)
          }
          continue
        }

        // useRef group
        if (/React\.useRef|useRef\(/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd && /React\.useRef|useRef\(/.test(lines[j].trim())) j++
          const count = j - groupStart
          if (count === 1) {
            result.push(`  [${groupStart + 1}] ${innerTrimmed.substring(0, 80)}`)
          } else {
            result.push(`  [${groupStart + 1}-${j}] useRef declarations (${count} refs)`)
          }
          continue
        }

        // useFrame block
        if (/helpers\.useFrame|useFrame\s*\(/.test(innerTrimmed)) {
          const blockEnd = findStatementEnd(lines, j)
          result.push(
            `  [${innerLn}-${blockEnd + 1}] useFrame animation block (${blockEnd - j + 1} lines)`,
          )
          j = blockEnd + 1
          continue
        }

        // useMemo block
        if (/React\.useMemo\s*\(/.test(innerTrimmed)) {
          const nameMatch = innerTrimmed.match(/^(?:var|const|let)\s+(\w+)/)
          const name = nameMatch ? nameMatch[1] : 'useMemo'
          const blockEnd = findStatementEnd(lines, j)
          result.push(
            `  [${innerLn}-${blockEnd + 1}] ${name} = React.useMemo(...) (${blockEnd - j + 1} lines)`,
          )
          j = blockEnd + 1
          continue
        }

        // Inner function
        if (/^\s*function\s+(\w+)\s*\(/.test(innerLine)) {
          const funcName = innerLine.match(/function\s+(\w+)/)?.[1] ?? 'anonymous'
          const blockEnd = findClosingBrace(lines, j)
          result.push(
            `  [${innerLn}-${blockEnd + 1}] function ${funcName}() { ... } (${blockEnd - j + 1} lines)`,
          )
          j = blockEnd + 1
          continue
        }

        // Consecutive var declarations
        if (/^(var|const|let)\s+\w+/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd) {
            const declTrimmed = lines[j].trim()
            if (!/^(var|const|let)\s+\w+/.test(declTrimmed)) break
            const declEnd = findStatementEnd(lines, j)
            j = declEnd + 1
          }
          const count = j - groupStart
          if (count === 1) {
            result.push(`  [${groupStart + 1}] ${innerTrimmed.substring(0, 80)}`)
          } else {
            result.push(`  [${groupStart + 1}-${j}] variable declarations (${count} lines)`)
          }
          continue
        }

        // Return block
        if (/return\s+React\.createElement/.test(innerTrimmed)) {
          let parenDepth = 0
          let retEnd = j
          for (let k = j; k < sceneEnd; k++) {
            for (const ch of lines[k]) {
              if (ch === '(') parenDepth++
              else if (ch === ')') parenDepth--
            }
            if (parenDepth <= 0) {
              retEnd = k
              break
            }
          }

          result.push(
            `  [${innerLn}-${retEnd + 1}] return React.createElement(React.Fragment, null,`,
          )
          const childEntries = extractFragmentChildren(lines, j, retEnd)
          for (const child of childEntries) {
            result.push(`    [${child.startLine}-${child.endLine}] ${child.summary}`)
          }
          // Insertion hint: last 3 lines before close
          const hintStart = Math.max(j + 1, retEnd - 2)
          result.push(`    --- last lines before close (insertion point) ---`)
          for (let h = hintStart; h <= retEnd; h++) {
            result.push(`    ${h + 1} | ${lines[h]}`)
          }
          result.push(`  [${retEnd + 1}] );`)

          j = retEnd + 1
          continue
        }

        result.push(`  [${innerLn}] ${innerTrimmed.substring(0, 80)}`)
        j++
      }

      result.push(`[${sceneEnd + 1}] }`)
      i = sceneEnd + 1
      continue
    }

    // Other function
    if (/^function\s+(\w+)\s*\(/.test(trimmed)) {
      const funcName = trimmed.match(/function\s+(\w+)/)?.[1] ?? 'anonymous'
      const blockEnd = findClosingBrace(lines, i)
      result.push(
        `[${ln}-${blockEnd + 1}] function ${funcName}() { ... } (${blockEnd - i + 1} lines)`,
      )
      i = blockEnd + 1
      continue
    }

    if (/^return\s+Scene/.test(trimmed)) {
      result.push(`[${ln}] return Scene;`)
      i++
      continue
    }

    result.push(`[${ln}] ${trimmed.substring(0, 80)}`)
    i++
  }

  return result.join('\n')
}

// ---------------------------------------------------------------------------
// Tool definitions — OpenAI FunctionTool format
// ---------------------------------------------------------------------------

const editTools: FunctionTool[] = [
  {
    type: 'function',
    name: 'find_and_replace',
    description:
      'Replace an exact substring in the current code with new text. The old_string must match exactly one location. Include enough surrounding context lines to make the match unique. To write initial code, pass empty old_string.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        old_string: {
          type: 'string',
          description:
            'The exact text to find in the current code. Must match exactly (including whitespace/indentation). Pass empty string "" to write initial code to an empty file.',
        },
        new_string: {
          type: 'string',
          description: 'The replacement text. The old_string will be replaced with this.',
        },
      },
      required: ['old_string', 'new_string'],
    },
  },
  {
    type: 'function',
    name: 'view_range',
    description:
      'View a range of lines from the current code (max 80 lines per call). Use this to inspect the specific section you plan to edit. Do NOT view the whole file.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        start_line: {
          type: 'number',
          description: 'First line to view (1-indexed, inclusive).',
        },
        end_line: {
          type: 'number',
          description: 'Last line to view (1-indexed, inclusive). Max 80 lines per call.',
        },
      },
      required: ['start_line', 'end_line'],
    },
  },
  {
    type: 'function',
    name: 'search_code',
    description:
      'Search the current code for a pattern (substring or regex). Returns matching lines with 2 lines of context. Use this to find insertion points without viewing large ranges.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Substring or regex pattern to search for in the code.',
        },
      },
      required: ['pattern'],
    },
  },
  {
    type: 'function',
    name: 'markChecklistItemDone',
    description:
      'Mark a checklist item as done after you have fully implemented it. Call this after completing each item.',
    strict: false,
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id of the checklist item to mark as done.' },
      },
      required: ['id'],
    },
  },
]

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------

function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  state: { currentCode: string },
  checklist: ChecklistItem[],
): string {
  if (toolName === 'find_and_replace') {
    const { old_string, new_string } = args as { old_string: string; new_string: string }
    const result = findAndReplace(state.currentCode, old_string, new_string)
    if (!result.ok) {
      return JSON.stringify({ success: false, error: (result as { ok: false; error: string }).error })
    }
    state.currentCode = (result as { ok: true; code: string }).code
    const lineCount = state.currentCode.split('\n').length
    console.log(`[v4] find_and_replace: ok (${lineCount} lines)`)
    return JSON.stringify({ success: true, lines: lineCount })
  }

  if (toolName === 'view_range') {
    const { start_line, end_line } = args as { start_line: number; end_line: number }
    const codeLines = state.currentCode.split('\n')
    const totalLines = codeLines.length
    const MAX_VIEW_LINES = 80

    if (start_line < 1 || end_line < start_line || start_line > totalLines) {
      return JSON.stringify({
        success: false,
        error: `Invalid range. Code has ${totalLines} lines (valid: 1-${totalLines}).`,
      })
    }

    const clampedEnd = Math.min(end_line, totalLines, start_line + MAX_VIEW_LINES - 1)
    const selectedLines = codeLines.slice(start_line - 1, clampedEnd)
    const numberedCode = selectedLines
      .map((line, idx) => `${start_line + idx} | ${line}`)
      .join('\n')

    const wasCapped = end_line > clampedEnd
    console.log(
      `[v4] view_range: lines ${start_line}-${clampedEnd}${wasCapped ? ' [capped]' : ''}`,
    )
    return JSON.stringify({
      success: true,
      lines_shown: `${start_line}-${clampedEnd}`,
      total_lines: totalLines,
      code: numberedCode,
      ...(wasCapped
        ? {
            note: `Capped to ${MAX_VIEW_LINES} lines. Call again for lines ${clampedEnd + 1}+.`,
          }
        : {}),
    })
  }

  if (toolName === 'search_code') {
    const { pattern } = args as { pattern: string }
    const codeLines = state.currentCode.split('\n')
    const CONTEXT = 2
    const MAX_MATCHES = 15

    let regex: RegExp
    try {
      regex = new RegExp(pattern, 'i')
    } catch {
      regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }

    const matchIndices: number[] = []
    for (let idx = 0; idx < codeLines.length; idx++) {
      if (regex.test(codeLines[idx])) {
        matchIndices.push(idx)
        if (matchIndices.length >= MAX_MATCHES) break
      }
    }

    if (matchIndices.length === 0) {
      console.log(`[v4] search_code: no matches for "${pattern}"`)
      return JSON.stringify({ success: true, matches: 0, results: '(no matches)' })
    }

    const ranges: Array<[number, number]> = []
    for (const idx of matchIndices) {
      const start = Math.max(0, idx - CONTEXT)
      const end = Math.min(codeLines.length - 1, idx + CONTEXT)
      if (ranges.length > 0 && start <= ranges[ranges.length - 1][1] + 1) {
        ranges[ranges.length - 1][1] = end
      } else {
        ranges.push([start, end])
      }
    }

    const resultParts: string[] = []
    for (const [start, end] of ranges) {
      for (let idx = start; idx <= end; idx++) {
        const marker = regex.test(codeLines[idx]) ? '>' : ' '
        resultParts.push(`${marker} ${idx + 1} | ${codeLines[idx]}`)
      }
      resultParts.push('---')
    }

    console.log(`[v4] search_code: ${matchIndices.length} matches for "${pattern}"`)
    return JSON.stringify({
      success: true,
      matches: matchIndices.length,
      total_lines: codeLines.length,
      results: resultParts.join('\n'),
    })
  }

  if (toolName === 'markChecklistItemDone') {
    const { id } = args as { id: string }
    const item = checklist.find((i) => i.id === id)
    if (!item) {
      return JSON.stringify({ success: false, error: `Checklist item "${id}" not found.` })
    }
    item.done = true
    console.log(`[v4] markChecklistItemDone: ${id}`)
    return JSON.stringify({ success: true, id, done: true })
  }

  return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
}

// ---------------------------------------------------------------------------
// Code state formatting — full or skeleton depending on length
// ---------------------------------------------------------------------------

function formatCodeState(code: string): { label: string; content: string } {
  if (!code) {
    return {
      label: 'CURRENT CODE',
      content: '(empty — use find_and_replace with empty old_string to write the initial code)',
    }
  }

  const lineCount = code.split('\n').length
  if (lineCount > SKELETON_THRESHOLD) {
    const skeleton = generateSkeleton(code)
    if (skeleton.split('\n').length >= 4) {
      return { label: 'CODE SKELETON', content: skeleton }
    }
  }

  return { label: 'CURRENT CODE', content: addLineNumbers(code) }
}

// ---------------------------------------------------------------------------
// Main export — multi-turn conversation using OpenAI Responses API
// ---------------------------------------------------------------------------

export async function generateVisualizationCodeV4(args: {
  openaiClient: OpenAI
  blueprint: string
  checklist: ChecklistItem[]
  renderType: RenderType
  userPrompt: string
}): Promise<
  | { ok: true; code: string; checklist: ChecklistItem[] }
  | { ok: false; error: VisualizationValidationError }
> {
  const checklist = args.checklist
  if (checklist.length === 0) {
    console.warn('[v4] empty checklist')
    return { ok: false, error: { phase: 'schema', message: 'Empty implementation checklist.' } }
  }

  console.log('[v4] starting with checklist:', checklist.map((i) => i.id))

  const state = { currentCode: '' }
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  // ---- System instructions (sent once, cached by OpenAI) ----
  const is3D = args.renderType === '3D_WEBGL'
  const codeStructureGuide = is3D
    ? [
        'CODE STRUCTURE (3D_WEBGL):',
        'The code runs inside a function body with React, runtimeState, and helpers already in scope.',
        'ONLY React, runtimeState, and helpers are available. THREE is NOT in scope.',
        'Use R3F string tags ("mesh", "sphereGeometry", "meshStandardMaterial", etc.) with React.createElement.',
        'Define an inner Scene function and return it:',
        '',
        '  function Scene() {',
        '    const { useFrame, ScreenOverlay, InfoPoint } = helpers;',
        '    // state, refs, effects here',
        '    return React.createElement(React.Fragment, null,',
        '      // ALL visual elements',
        '    );',
        '  }',
        '  return Scene;',
        '',
        'The return statement is the MOST IMPORTANT part — it must contain ALL rendered elements.',
      ].join('\n')
    : [
        'CODE STRUCTURE (2D_CANVAS):',
        'The code runs inside a function body with ctx, canvas, runtimeState, and helpers already in scope.',
        'Draw everything using ctx (fillRect, arc, lineTo, fillText, etc.).',
        'The function is called every frame — draw the full scene each time.',
      ].join('\n')

  const instructions = [
    'You are a code-generation agent. You receive a checklist and current code state.',
    'Use find_and_replace to write and edit code. Work through uncompleted checklist items in order.',
    'After fully implementing a checklist item, call markChecklistItemDone with its id.',
    'Do NOT explain, narrate, or send text-only responses. Just make tool calls.',
    'When all checklist items are done, stop making tool calls.',
    '',
    'CRITICAL RULES (violations crash the app):',
    '',
    'THREE IS NOT AVAILABLE:',
    '- NEVER use THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything.',
    '- For vectors, use plain arrays: [x, y, z]. For colors, use hex strings.',
    '- Only these variables are in scope: React, runtimeState, helpers.',
    '',
    'REACT ELEMENT RULES:',
    '- Every React.createElement() call MUST have a valid first argument: string tag or component.',
    '- NEVER write React.createElement( React.createElement(...) ).',
    '- All new elements MUST be children INSIDE the existing React.createElement(React.Fragment, null, ...).',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers.',
    '',
    'CODE VIEWING:',
    '- When code is short, you see full code. When longer, you see a SKELETON with [line] ranges.',
    '- The skeleton includes insertion hints (last lines before the Fragment close).',
    '- Use view_range (max 80 lines) to inspect ONLY the section you plan to edit.',
    '- Use search_code to find specific patterns instead of scanning large ranges.',
    '- Do NOT view the entire file in chunks — the skeleton shows the structure.',
    '- ALWAYS inspect the actual code before calling find_and_replace when in skeleton mode.',
    '- Your find_and_replace old_string must match the ACTUAL code, not the skeleton.',
    '',
    codeStructureGuide,
    '',
    '=== BLUEPRINT ===',
    args.blueprint,
    '=== END BLUEPRINT ===',
    '',
    '=== RENDERING ENGINE RULES ===',
    renderRules,
    '=== END RENDERING ENGINE RULES ===',
  ].join('\n')

  // ---- Initial user message ----
  const { label: codeLabel, content: codeContent } = formatCodeState(state.currentCode)

  const initialInput: ResponseInputItem[] = [
    {
      role: 'user',
      content: [
        'Implement the visualization code according to the checklist below.',
        'Work through items in order. After fully implementing each item, call markChecklistItemDone.',
        '',
        '=== CHECKLIST ===',
        formatChecklist(checklist),
        '=== END CHECKLIST ===',
        '',
        `=== ${codeLabel} ===`,
        codeContent,
        `=== END ${codeLabel} ===`,
        '',
        `User request: ${args.userPrompt}`,
        '',
        'IMPORTANT: When adding new elements, place them INSIDE the existing return React.createElement(React.Fragment, null, ...) as additional comma-separated children.',
        '',
        'Begin implementing the first uncompleted checklist item.',
      ].join('\n'),
    },
  ]

  // ---- Main loop: multi-turn conversation with previous_response_id ----
  const MAX_ITERATIONS = 100
  const CODE_STATE_INTERVAL = 8 // inject code state every N rounds
  const maxValidationAttempts = 3
  let iteration = 0
  let consecutiveNoToolCalls = 0
  let previousResponseId: string | undefined
  let nextInput: ResponseInputItem[] = initialInput

  console.log('[v4] instructions length:', instructions.length)

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++

      const allDone = checklist.every((i) => i.done)
      if (allDone) {
        console.log('[v4] all checklist items done')
        break
      }

      console.log(
        `[v4] iteration ${iteration}, pending: ${checklist.filter((i) => !i.done).map((i) => i.id).join(', ')}`,
      )

      const response = await args.openaiClient.responses.create({
        model: 'gpt-5.2',
        instructions,
        input: nextInput,
        tools: editTools,
        ...(previousResponseId ? { previous_response_id: previousResponseId } : {}),
      })

      previousResponseId = response.id

      console.log(`[v4] iteration ${iteration} status: ${response.status}`)

      const functionCalls = response.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      if (functionCalls.length === 0) {
        consecutiveNoToolCalls++
        console.log(
          `[v4] no tool calls (consecutive: ${consecutiveNoToolCalls})`,
        )

        if (checklist.every((i) => i.done)) {
          console.log('[v4] all items done — stopping')
          break
        }

        if (consecutiveNoToolCalls >= 3) {
          console.warn('[v4] giving up — no tool calls in 3 consecutive rounds')
          break
        }

        // Nudge the model with a reminder
        const pending = checklist.filter((i) => !i.done)
        nextInput = [
          {
            role: 'user',
            content: [
              'You stopped making tool calls but these checklist items are NOT done yet:',
              ...pending.map((i) => `- \`${i.id}\`: ${i.description}`),
              '',
              'Continue implementing them. Use find_and_replace to make edits.',
              'Call markChecklistItemDone when each item is complete.',
            ].join('\n'),
          },
        ]
        continue
      }

      consecutiveNoToolCalls = 0

      // Execute tool calls — only send function_call_output items back.
      // With previous_response_id, the function_call items are already part
      // of the conversation; re-sending them causes a duplicate ID error.
      const toolResults: ResponseInputItem[] = []

      for (const fc of functionCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const output = executeToolCall(fc.name, toolArgs, state, checklist)
        console.log(`[v4] ${fc.name}: ${output.substring(0, 200)}`)

        toolResults.push({
          type: 'function_call_output',
          call_id: fc.call_id,
          output,
        })
      }

      nextInput = toolResults

      // Periodically inject code state so the model stays oriented
      if (iteration % CODE_STATE_INTERVAL === 0 && state.currentCode) {
        const { label, content } = formatCodeState(state.currentCode)
        const pending = checklist.filter((i) => !i.done)
        nextInput.push({
          role: 'user',
          content: [
            `--- Code state checkpoint (${state.currentCode.split('\n').length} lines) ---`,
            '',
            `=== ${label} ===`,
            content,
            `=== END ${label} ===`,
            '',
            '=== CHECKLIST PROGRESS ===',
            formatChecklist(checklist),
            '=== END CHECKLIST PROGRESS ===',
            '',
            `Continue implementing: ${pending.map((i) => i.id).join(', ')}`,
          ].join('\n'),
        })
        console.log(`[v4] injected code state checkpoint at iteration ${iteration}`)
      }

      console.log(
        `[v4] code: ${state.currentCode.split('\n').length} lines, progress: ${checklist.filter((i) => i.done).length}/${checklist.length}`,
      )
    }

    // ---- Validation + repair ----
    console.log('[v4] starting validation phase')

    for (let attempt = 1; attempt <= maxValidationAttempts; attempt++) {
      const validation = validateGeneratedSceneCode(state.currentCode, args.renderType)
      if (validation.ok) {
        console.log('[v4] validation passed')
        break
      }

      console.log(`[v4] validation failed (attempt ${attempt}): ${(validation as { ok: false; error: VisualizationValidationError }).error.message}`)

      if (attempt === maxValidationAttempts) {
        console.warn('[v4] validation failed after all repair attempts')
        return { ok: false, error: (validation as { ok: false; error: VisualizationValidationError }).error }
      }

      // Repair: fresh conversation (no previous_response_id) for focused fix
      const repairInput: ResponseInputItem[] = [
        {
          role: 'user',
          content: [
            'The code has a validation error. Fix it.',
            '',
            `Error: ${(validation as { ok: false; error: VisualizationValidationError }).error.phase}: ${(validation as { ok: false; error: VisualizationValidationError }).error.message}`,
            (validation as { ok: false; error: VisualizationValidationError }).error.details
              ? `Details: ${(validation as { ok: false; error: VisualizationValidationError }).error.details!.join(', ')}`
              : '',
            '',
            '=== CURRENT CODE ===',
            addLineNumbers(state.currentCode),
            '=== END CURRENT CODE ===',
            '',
            'Fix the error using find_and_replace.',
          ].join('\n'),
        },
      ]

      const repairResponse = await args.openaiClient.responses.create({
        model: 'gpt-5.2',
        instructions,
        input: repairInput,
        tools: editTools,
      })

      const repairCalls = repairResponse.output.filter(
        (o): o is ResponseFunctionToolCall => o.type === 'function_call',
      )

      console.log(`[v4] repair attempt ${attempt}: ${repairCalls.length} tool calls`)

      for (const fc of repairCalls) {
        const toolArgs = JSON.parse(fc.arguments) as Record<string, unknown>
        const output = executeToolCall(fc.name, toolArgs, state, checklist)
        console.log(`[v4] repair ${fc.name}: ${output.substring(0, 200)}`)
      }
    }
  } catch (error) {
    console.error('[v4] agent run failed', error)
  }

  // Final safety validation
  const finalValidation = validateGeneratedSceneCode(state.currentCode, args.renderType)
  if (!finalValidation.ok) {
    console.warn('[v4] final code failed validation', (finalValidation as { ok: false; error: VisualizationValidationError }).error)
    return { ok: false, error: (finalValidation as { ok: false; error: VisualizationValidationError }).error }
  }

  const completed = checklist.filter((i) => i.done).length
  console.log(`[v4] finished: ${completed}/${checklist.length} items completed`)

  return { ok: true, code: state.currentCode, checklist }
}
