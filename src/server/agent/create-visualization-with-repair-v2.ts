import { generateText, tool } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
import { z } from 'zod'
import type { VisualizationValidationError } from '../../types/agent'
import type { RenderType } from '../../types/visualization'
import { validateGeneratedSceneCode } from './validate-generated-scene-code'
import { getRenderTypeRules } from './prompts'

// ---------------------------------------------------------------------------
// Helpers (copied from v1 to keep v2 self-contained)
// ---------------------------------------------------------------------------

export type ChecklistItem = {
  id: string
  description: string
  done: boolean
}

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
// Patch parsing & application
// ---------------------------------------------------------------------------

type PatchHunk = {
  oldLines: string[]
  newLines: string[]
}

/**
 * Parse a unified-diff style patch string into hunks.
 *
 * Format:
 *   @@
 *   -removed line
 *   +added line
 *    context line   (leading space)
 *
 * Each `@@` starts a new hunk. Within a hunk:
 *   `-` prefix → line exists in old code, should be removed
 *   `+` prefix → line is new, should be added
 *   ` ` prefix → context line present in both old and new
 */
function parsePatch(patch: string): PatchHunk[] {
  const hunks: PatchHunk[] = []
  const rawHunks = patch.split(/^@@/m).filter((s) => s.trim().length > 0)

  for (const raw of rawHunks) {
    const lines = raw.split('\n')
    const oldLines: string[] = []
    const newLines: string[] = []

    for (const line of lines) {
      if (line.startsWith('-')) {
        oldLines.push(line.slice(1))
      } else if (line.startsWith('+')) {
        newLines.push(line.slice(1))
      } else if (line.startsWith(' ')) {
        // Context line — present in both old and new
        oldLines.push(line.slice(1))
        newLines.push(line.slice(1))
      }
      // Skip empty/whitespace-only lines that aren't prefixed (e.g. blank line after @@)
    }

    if (oldLines.length > 0 || newLines.length > 0) {
      hunks.push({ oldLines, newLines })
    }
  }

  return hunks
}

/**
 * Apply parsed hunks to a code string. Each hunk's `oldLines` are located
 * in the code and replaced with `newLines`. Hunks are applied sequentially.
 */
function applyPatch(code: string, patch: string): { ok: true; code: string } | { ok: false; error: string } {
  const hunks = parsePatch(patch)
  if (hunks.length === 0) {
    return { ok: false, error: 'Patch contains no valid hunks.' }
  }

  let current = code

  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i]
    const oldBlock = hunk.oldLines.join('\n')
    const newBlock = hunk.newLines.join('\n')

    if (oldBlock.length === 0) {
      // Pure insertion (no old lines) — append to end
      current = current + (current.endsWith('\n') ? '' : '\n') + newBlock
      continue
    }

    const idx = current.indexOf(oldBlock)
    if (idx === -1) {
      return {
        ok: false,
        error: `Hunk ${i + 1}/${hunks.length} failed: could not find the old block in the code. Make sure context and removed lines match exactly.\nExpected to find:\n${oldBlock}`,
      }
    }

    current = current.slice(0, idx) + newBlock + current.slice(idx + oldBlock.length)
  }

  return { ok: true, code: current }
}

// ---------------------------------------------------------------------------
// Skeleton generation — structural summary of code for context-efficient prompts
// ---------------------------------------------------------------------------

const SKELETON_THRESHOLD = 500

/**
 * Find the index of the closing brace `}` that matches the opening `{`
 * on or after `startIdx`. Returns `lines.length - 1` as fallback.
 */
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

/**
 * Find the end of a multi-line statement (var/const declaration with object
 * literals, arrays, etc). Tracks `{}[]()` depth and ends at `;` when depth is 0,
 * or when depth returns to 0 after going positive.
 */
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

/**
 * Extract the top-level children of a React.createElement(React.Fragment, null, ...) block.
 * Returns summary entries for each direct child element.
 */
function extractFragmentChildren(
  lines: string[],
  returnStart: number,
  returnEnd: number,
): Array<{ startLine: number; endLine: number; summary: string }> {
  const children: Array<{ startLine: number; endLine: number; summary: string }> = []

  // Find where the Fragment's children begin:
  // return React.createElement(    ← depth 1
  //   React.Fragment,
  //   null,
  //   <children start here at depth 2>
  // The base depth for children is 2 (one for createElement's (, one for Fragment args)
  let baseDepth = -1
  let parenDepth = 0
  let childrenStartLine = returnStart

  // Scan to find "null," which precedes the children
  for (let k = returnStart; k <= returnEnd; k++) {
    const line = lines[k]
    if (/null\s*,/.test(line)) {
      // Count the paren depth at this point to establish base
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

  // Now scan from childrenStartLine, tracking paren depth.
  // Each time we see React.createElement at baseDepth, that's a top-level child.
  let depth = baseDepth
  let childStart = -1
  let childTag = ''

  for (let k = childrenStartLine; k <= returnEnd; k++) {
    const line = lines[k]
    const trimmed = line.trim()

    // Check if this line starts a new child at base depth
    if (depth === baseDepth && /React\.createElement\s*\(/.test(trimmed)) {
      // If we were tracking a previous child, close it
      if (childStart !== -1) {
        children.push({
          startLine: childStart + 1,
          endLine: k, // previous line is end
          summary: childTag,
        })
      }
      // Extract the tag/component name — may be on same line or next line
      let tagMatch = trimmed.match(/React\.createElement\s*\(\s*["']([^"']+)["']/) ||
        trimmed.match(/React\.createElement\s*\(\s*(\w+)/)
      if (!tagMatch && k + 1 <= returnEnd) {
        // Tag is on the next line (e.g. React.createElement(\n  "group",)
        const nextTrimmed = lines[k + 1].trim()
        tagMatch = nextTrimmed.match(/^["']([^"']+)["']/) ||
          nextTrimmed.match(/^(\w+)/)
      }
      childTag = tagMatch ? `React.createElement("${tagMatch[1]}", ...)` : 'React.createElement(...)'
      childStart = k
    }

    // Also detect .map() calls that produce children (e.g. infallSeed.map(function(b) { ... }))
    if (depth === baseDepth && /\.map\s*\(\s*function/.test(trimmed) && childStart === -1) {
      const mapMatch = trimmed.match(/(\w+)\.map\s*\(/)
      childTag = mapMatch ? `${mapMatch[1]}.map(...)` : '.map(...)'
      childStart = k
    }

    // Track depth
    for (const ch of line) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
    }

    // When depth drops back to base, close current child
    if (depth === baseDepth && childStart !== -1 && k > childStart) {
      children.push({
        startLine: childStart + 1,
        endLine: k + 1,
        summary: childTag,
      })
      childStart = -1
      childTag = ''
    }
  }

  // Close any trailing child
  if (childStart !== -1) {
    children.push({
      startLine: childStart + 1,
      endLine: returnEnd + 1,
      summary: childTag,
    })
  }

  return children
}

/**
 * Generate a structural skeleton of the code, showing function boundaries,
 * state declarations, and block ranges without full implementation details.
 */
function generateSkeleton(code: string): string {
  const lines = code.split('\n')
  const totalLines = lines.length
  const result: string[] = [`(${totalLines} total lines — use view_range to inspect sections)`]

  let i = 0
  while (i < totalLines) {
    const line = lines[i]
    const trimmed = line.trim()
    const ln = i + 1 // 1-indexed

    // Skip blank lines
    if (trimmed === '') { i++; continue }

    // Top-level var/const declarations
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

    // function Scene() — recurse into its body
    if (/^function\s+Scene\s*\(/.test(trimmed)) {
      const sceneEnd = findClosingBrace(lines, i)
      result.push(`[${ln}-${sceneEnd + 1}] function Scene() {`)

      // Scan inside Scene for sub-blocks
      let j = i + 1
      while (j < sceneEnd) {
        const innerLine = lines[j]
        const innerTrimmed = innerLine.trim()
        const innerLn = j + 1

        if (innerTrimmed === '') { j++; continue }

        // Helpers destructuring (e.g. var useFrame = helpers.useFrame;)
        if (/=\s*helpers\.\w+/.test(innerTrimmed) || /const\s*\{.*\}\s*=\s*helpers/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd && /=\s*helpers\.\w+/.test(lines[j].trim())) j++
          const count = j - groupStart
          if (count <= 1) {
            // Single line or matched by the const{} pattern
            result.push(`  [${groupStart + 1}] ${innerTrimmed.substring(0, 80)}`)
            j = Math.max(j, groupStart + 1)
          } else {
            result.push(`  [${groupStart + 1}-${j}] helpers destructuring (${count} lines)`)
          }
          continue
        }

        // runtimeState.params initialization block (including guard like `if (!runtimeState.params)`)
        if (/runtimeState\.params/.test(innerTrimmed)) {
          const groupStart = j
          while (j < sceneEnd && /runtimeState\.params/.test(lines[j].trim())) j++
          const count = j - groupStart
          result.push(`  [${groupStart + 1}-${j}] runtimeState.params initialization (${count} lines)`)
          continue
        }

        // Group consecutive useState
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

        // Group consecutive useRef
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
          result.push(`  [${innerLn}-${blockEnd + 1}] useFrame animation block (${blockEnd - j + 1} lines)`)
          j = blockEnd + 1
          continue
        }

        // React.useMemo block (e.g. var innerDiskData = React.useMemo(function () { ... }, [...]);)
        if (/React\.useMemo\s*\(/.test(innerTrimmed)) {
          const nameMatch = innerTrimmed.match(/^(?:var|const|let)\s+(\w+)/)
          const name = nameMatch ? nameMatch[1] : 'useMemo'
          const blockEnd = findStatementEnd(lines, j)
          result.push(`  [${innerLn}-${blockEnd + 1}] ${name} = React.useMemo(...) (${blockEnd - j + 1} lines)`)
          j = blockEnd + 1
          continue
        }

        // Inner function declarations
        if (/^\s*function\s+(\w+)\s*\(/.test(innerLine)) {
          const funcName = innerLine.match(/function\s+(\w+)/)?.[1] ?? 'anonymous'
          const blockEnd = findClosingBrace(lines, j)
          result.push(`  [${innerLn}-${blockEnd + 1}] function ${funcName}() { ... } (${blockEnd - j + 1} lines)`)
          j = blockEnd + 1
          continue
        }

        // Group consecutive var/const/let declarations (non-useMemo, non-useState, non-useRef)
        if (/^(var|const|let)\s+\w+/.test(innerTrimmed)) {
          const groupStart = j
          // Each declaration may be multi-line
          while (j < sceneEnd) {
            const declTrimmed = lines[j].trim()
            if (!/^(var|const|let)\s+\w+/.test(declTrimmed)) break
            // Skip past multi-line statement
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

        // Return statement block — show top-level children
        if (/return\s+React\.createElement/.test(innerTrimmed)) {
          // Find the end of the return block
          let parenDepth = 0
          let retEnd = j
          for (let k = j; k < sceneEnd; k++) {
            for (const ch of lines[k]) {
              if (ch === '(') parenDepth++
              else if (ch === ')') parenDepth--
            }
            if (parenDepth <= 0) { retEnd = k; break }
          }

          result.push(`  [${innerLn}-${retEnd + 1}] return React.createElement(React.Fragment, null,`)
          // Extract top-level children of the Fragment
          // The Fragment's children start after "null," — each top-level child is
          // React.createElement(...) at paren depth = 2 (outer createElement + Fragment's parens)
          const childEntries = extractFragmentChildren(lines, j, retEnd)
          for (const child of childEntries) {
            result.push(`    [${child.startLine}-${child.endLine}] ${child.summary}`)
          }
          // Insertion hint: show the last 3 lines before closing ); so the model
          // knows exactly where to insert new children without calling view_range
          const hintStart = Math.max(j + 1, retEnd - 2)
          result.push(`    --- last lines before close (insertion point) ---`)
          for (let h = hintStart; h <= retEnd; h++) {
            result.push(`    ${h + 1} | ${lines[h]}`)
          }
          result.push(`  [${retEnd + 1}] );`)

          j = retEnd + 1
          continue
        }

        // Other lines — show truncated
        result.push(`  [${innerLn}] ${innerTrimmed.substring(0, 80)}`)
        j++
      }

      result.push(`[${sceneEnd + 1}] }`)
      i = sceneEnd + 1
      continue
    }

    // Other top-level function declarations
    if (/^function\s+(\w+)\s*\(/.test(trimmed)) {
      const funcName = trimmed.match(/function\s+(\w+)/)?.[1] ?? 'anonymous'
      const blockEnd = findClosingBrace(lines, i)
      result.push(`[${ln}-${blockEnd + 1}] function ${funcName}() { ... } (${blockEnd - i + 1} lines)`)
      i = blockEnd + 1
      continue
    }

    // return Scene;
    if (/^return\s+Scene/.test(trimmed)) {
      result.push(`[${ln}] return Scene;`)
      i++
      continue
    }

    // Fallback — show the line
    result.push(`[${ln}] ${trimmed.substring(0, 80)}`)
    i++
  }

  // If skeleton is too sparse, it failed to parse — caller should fall back to full code
  return result.join('\n')
}

// ---------------------------------------------------------------------------
// Tool definitions — schema-only, no execute (we process calls manually)
// ---------------------------------------------------------------------------

const editTools = {
  apply_patch: tool({
    description:
      'Apply a unified-diff style patch to the current code. The patch uses @@ to delimit hunks. Lines starting with "-" are removed, "+" are added, and " " (space) are context lines that must match.',
    inputSchema: z.object({
      patch: z
        .string()
        .describe(
          'A unified-diff style patch. Use @@ to start each hunk. Prefix removed lines with "-", added lines with "+", and context lines with " " (space).',
        ),
    }),
  }),
  view_range: tool({
    description:
      'View a range of lines from the current code (max 80 lines per call). Use this to inspect the specific section you plan to edit — do NOT view the whole file. Returns the actual code with line numbers.',
    inputSchema: z.object({
      start_line: z.number().describe('First line to view (1-indexed, inclusive).'),
      end_line: z.number().describe('Last line to view (1-indexed, inclusive). Max 80 lines per call.'),
    }),
  }),
  search_code: tool({
    description:
      'Search the current code for a pattern (substring or regex). Returns matching lines with 2 lines of context each. Use this to find insertion points or specific code without viewing large ranges.',
    inputSchema: z.object({
      pattern: z.string().describe('Substring or regex pattern to search for in the code.'),
    }),
  }),
  markChecklistItemDone: tool({
    description:
      'Mark a checklist item as done after you have fully implemented it. Call this after completing each item.',
    inputSchema: z.object({
      id: z.string().describe('The id of the checklist item to mark as done.'),
    }),
  }),
}

// ---------------------------------------------------------------------------
// Manual tool execution — processes tool calls against the mutable code state
// ---------------------------------------------------------------------------

function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  state: { currentCode: string },
  checklist: ChecklistItem[],
): string {
  if (toolName === 'apply_patch') {
    const { patch } = args as { patch: string }
    const result = applyPatch(state.currentCode, patch)
    if (!result.ok) {
      return JSON.stringify({ success: false, error: result.error })
    }
    state.currentCode = result.code
    console.log(`[generateCodeV2] apply_patch: ok (${state.currentCode.split('\n').length} lines)`)
    return JSON.stringify({ success: true, lines: state.currentCode.split('\n').length })
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

    // Cap at MAX_VIEW_LINES to prevent full-file reads
    const clampedEnd = Math.min(end_line, totalLines, start_line + MAX_VIEW_LINES - 1)
    const selectedLines = codeLines.slice(start_line - 1, clampedEnd)
    const numberedCode = selectedLines
      .map((line, idx) => `${start_line + idx} | ${line}`)
      .join('\n')

    const wasCapped = end_line > clampedEnd
    console.log(`[generateCodeV2] view_range: lines ${start_line}-${clampedEnd} (${clampedEnd - start_line + 1} lines)${wasCapped ? ' [capped from ' + end_line + ']' : ''}`)
    return JSON.stringify({
      success: true,
      lines_shown: `${start_line}-${clampedEnd}`,
      total_lines: totalLines,
      code: numberedCode,
      ...(wasCapped ? { note: `Capped to ${MAX_VIEW_LINES} lines. Request a smaller range or call again for lines ${clampedEnd + 1}+.` } : {}),
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
      // Fall back to literal substring match
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
      console.log(`[generateCodeV2] search_code: no matches for "${pattern}"`)
      return JSON.stringify({ success: true, matches: 0, results: '(no matches)' })
    }

    // Merge overlapping context ranges
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

    const resultStr = resultParts.join('\n')
    console.log(`[generateCodeV2] search_code: ${matchIndices.length} matches for "${pattern}"`)
    return JSON.stringify({
      success: true,
      matches: matchIndices.length,
      total_lines: codeLines.length,
      results: resultStr,
    })
  }

  if (toolName === 'markChecklistItemDone') {
    const { id } = args as { id: string }
    const item = checklist.find((i) => i.id === id)
    if (!item) {
      return JSON.stringify({ success: false, error: `Checklist item "${id}" not found.` })
    }
    item.done = true
    console.log(`[generateCodeV2] markChecklistItemDone: ${id}`)
    return JSON.stringify({ success: true, id, done: true })
  }

  return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
}

// ---------------------------------------------------------------------------
// Structured edit history with recency-based view_range retention
// ---------------------------------------------------------------------------

type HistoryEntry = {
  round: number
  sequenceNum: number // global counter for recency tracking
  toolName: string
  briefArgs: string   // truncated args summary
  output: string      // full result output
  isViewRange: boolean
}

const VIEW_RANGE_RECENCY_LIMIT = 5 // keep full output for last N tool calls

function truncateArg(val: unknown, maxLen = 80): unknown {
  if (typeof val === 'string' && val.length > maxLen) {
    return val.slice(0, maxLen) + '...[truncated]'
  }
  return val
}

/**
 * Render the structured history entries into a string for the prompt.
 * Recent view_range results include full code; older ones are collapsed.
 */
function renderEditHistory(entries: HistoryEntry[], currentSequence: number): string {
  if (entries.length === 0) return ''

  const lines: string[] = []
  let currentRound = -1

  for (const entry of entries) {
    if (entry.round !== currentRound) {
      currentRound = entry.round
      const roundEntries = entries.filter((e) => e.round === currentRound)
      lines.push(`--- Round ${currentRound} (${roundEntries.length} calls) ---`)
    }

    if (entry.isViewRange) {
      const isRecent = (currentSequence - entry.sequenceNum) < VIEW_RANGE_RECENCY_LIMIT
      if (isRecent) {
        lines.push(`${entry.toolName}(${entry.briefArgs}) → ${entry.output}`)
      } else {
        // Collapse old view_range — extract just the range info
        try {
          const parsed = JSON.parse(entry.output)
          lines.push(`${entry.toolName}(${entry.briefArgs}) → viewed lines ${parsed.lines_shown} [collapsed — call view_range again if needed]`)
        } catch {
          lines.push(`${entry.toolName}(${entry.briefArgs}) → [collapsed]`)
        }
      }
    } else {
      lines.push(`${entry.toolName}(${entry.briefArgs}) → ${entry.output}`)
    }
  }

  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Main export — single while loop with fresh prompt each iteration
// ---------------------------------------------------------------------------

export async function generateVisualizationCodeV2(args: {
  openai: ReturnType<typeof createOpenAI>
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
    console.warn('[generateCodeV2] empty checklist')
    return { ok: false, error: { phase: 'schema', message: 'Empty implementation checklist.' } }
  }

  console.log('[generateCodeV2] starting with checklist:', checklist.map((i) => i.id))

  const state = { currentCode: '' }
  const renderRules = getRenderTypeRules(args.renderType).join('\n')

  // ---- System instructions ----
  const instructions = [
    'You are a code-generation agent. You receive the current code and a checklist of tasks to implement.',
    'The current code is provided in the prompt. Use apply_patch to write and edit code.',
    'Work through the uncompleted checklist items in order.',
    'After fully implementing a checklist item, call markChecklistItemDone with its id.',
    'Do NOT explain, narrate, or send text-only responses. Just make tool calls.',
    'When all checklist items are fully implemented and marked done, stop making tool calls.',
    '',
    'CRITICAL RULES (violations crash the app):',
    '',
    'THREE IS NOT AVAILABLE:',
    '- NEVER use THREE.Vector3, THREE.Color, THREE.Euler, new THREE.anything, or any THREE.* reference.',
    '- THREE is NOT in scope. The code runs in React Three Fiber — use R3F intrinsic string tags instead.',
    '- For vectors, use plain arrays: [x, y, z] for position/rotation/scale.',
    '- For colors, use hex strings: "#ff0000" or CSS color names.',
    '- For math, use plain JS: Math.PI, Math.sin(), etc.',
    '- Only these variables are in scope: React, runtimeState, helpers.',
    '',
    'REACT ELEMENT RULES:',
    '- Every React.createElement() call MUST have a valid first argument: a string tag ("mesh", "div") or a component reference (ScreenOverlay, InfoPoint).',
    '- NEVER write React.createElement( React.createElement(...) ) — the inner element becomes the "type" arg, which is invalid.',
    '- All new elements MUST be added as children INSIDE the existing React.createElement(React.Fragment, null, ...) return tree.',
    '- To add children: use apply_patch to find the last child before the closing ");", then append the new elements as additional comma-separated arguments.',
    '- NEVER wrap elements in a new React.createElement() without specifying a tag or component as the first argument.',
    '- ScreenOverlay and InfoPoint are COMPONENTS from helpers — use them as: React.createElement(ScreenOverlay, null, ...) and React.createElement(InfoPoint, { label: ..., ... })',
    '',
    'CODE VIEWING:',
    '- When the code is short (under ~100 lines), you see the full code.',
    '- When the code is longer, you see a SKELETON VIEW showing the structure with [line] ranges.',
    '- The skeleton includes insertion hints (last 3 lines before the Fragment close) so you can add new children WITHOUT calling view_range first.',
    '- Use view_range to inspect ONLY the 20-40 lines around your edit target. Max 80 lines per call.',
    '- Do NOT view_range the entire file in chunks — the skeleton already shows the structure.',
    '- Use search_code to find specific patterns (e.g. a variable name, closing bracket) instead of scanning large ranges.',
    '- ALWAYS call view_range or search_code to read the relevant section BEFORE calling apply_patch when in skeleton mode.',
    '- Your apply_patch context lines must match the ACTUAL code, not the skeleton summary.',
    '- If a prior apply_patch in the same turn changed line numbers, call view_range again before patching further.',
  ].join('\n')

  // ---- Code structure guide ----
  const is3D = args.renderType === '3D_WEBGL'
  const codeStructureGuide = is3D
    ? [
        'CODE STRUCTURE (3D_WEBGL):',
        'The code runs inside a function body with React, runtimeState, and helpers already in scope.',
        'ONLY React, runtimeState, and helpers are available. THREE is NOT in scope — never use THREE.Vector3, THREE.Color, etc.',
        'Use R3F string tags ("mesh", "sphereGeometry", "meshStandardMaterial", "pointLight", "group", etc.) with React.createElement.',
        'You must define an inner Scene function and return it:',
        '',
        '  function Scene() {',
        '    const { useFrame, ScreenOverlay, InfoPoint } = helpers;',
        '    // state, refs, effects here',
        '    return React.createElement(React.Fragment, null,',
        '      // ALL visual elements: meshes, lines, lights, InfoPoints',
        '      // ScreenOverlay with ACTUAL slider/button controls (not placeholder text)',
        '    );',
        '  }',
        '  return Scene;',
        '',
        'The return statement is the MOST IMPORTANT part — it must contain ALL rendered elements.',
        'Every mesh, every InfoPoint, every slider, every panel must be in the JSX tree.',
        'State and helper functions are useless if nothing is rendered.',
      ].join('\n')
    : [
        'CODE STRUCTURE (2D_CANVAS):',
        'The code runs inside a function body with ctx, canvas, runtimeState, and helpers already in scope.',
        'Draw everything using ctx (fillRect, arc, lineTo, fillText, etc.).',
        'The function is called every frame — draw the full scene each time.',
      ].join('\n')

  const referenceBlock = [
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

  // ---- Main loop ----
  const MAX_ITERATIONS = 30
  const MAX_HISTORY_ENTRIES = 200 // cap structured entries to prevent unbounded growth
  const maxValidationAttempts = 3
  let iteration = 0
  let consecutiveNoToolCalls = 0
  let toolCallSequence = 0 // global counter for recency-based view_range retention
  const historyEntries: HistoryEntry[] = []

  console.log('[generateCodeV2] checklist', JSON.stringify(checklist, null, 2))
  console.log('[generateCodeV2] instructions', instructions)

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++

      // Decide whether to show full code or skeleton
      const codeLines = state.currentCode.split('\n')
      const useSkeletonView = state.currentCode.length > 0 && codeLines.length > SKELETON_THRESHOLD

      let codeBlock: string
      let codeSectionLabel: string
      if (!state.currentCode) {
        codeBlock = '(empty — use apply_patch with only + lines to write the initial code)'
        codeSectionLabel = 'CURRENT CODE'
      } else if (useSkeletonView) {
        const skeleton = generateSkeleton(state.currentCode)
        // Fallback: if skeleton is too sparse (< 3 entries), show full code
        const skeletonLineCount = skeleton.split('\n').length
        if (skeletonLineCount < 4) {
          codeBlock = addLineNumbers(state.currentCode)
          codeSectionLabel = 'CURRENT CODE'
        } else {
          codeBlock = skeleton
          codeSectionLabel = 'CODE SKELETON'
        }
      } else {
        codeBlock = addLineNumbers(state.currentCode)
        codeSectionLabel = 'CURRENT CODE'
      }

      const promptParts = [
        'Implement the visualization code according to the checklist below.',
        'Work on the NEXT uncompleted item (marked [ ]). If all items are done, stop making tool calls.',
        '',
        '=== CHECKLIST PROGRESS ===',
        formatChecklist(checklist),
        '=== END CHECKLIST PROGRESS ===',
        '',
        `=== ${codeSectionLabel} ===`,
        codeBlock,
        `=== END ${codeSectionLabel} ===`,
        '',
        referenceBlock,
        '',
        `User request: ${args.userPrompt}`,
        '',
        'IMPORTANT: When adding new elements, place them INSIDE the existing return React.createElement(React.Fragment, null, ...) as additional comma-separated children.',
        'Find the right insertion point using apply_patch — locate the last child element before the closing ); of the Fragment and add your new elements after it.',
        '',
        'Make edits with apply_patch.',
        'If all checklist items are fully implemented in the code, make no tool calls.',
      ]

      // Add skeleton-specific guidance
      if (codeSectionLabel === 'CODE SKELETON') {
        promptParts.push('')
        promptParts.push('NOTE: You are seeing a skeleton view. Use view_range to inspect the actual code before calling apply_patch.')
      }

      // Render and append edit history
      const renderedHistory = renderEditHistory(historyEntries, toolCallSequence)
      if (renderedHistory) {
        promptParts.push('')
        promptParts.push('=== EDIT HISTORY (all tool calls so far) ===')
        promptParts.push(renderedHistory)
        promptParts.push('=== END EDIT HISTORY ===')
      }

      const userMessage = promptParts.join('\n')

      console.log(
        `[generateCodeV2] iteration ${iteration}, pending items: ${checklist.filter((i) => !i.done).map((i) => i.id).join(', ')}, mode: ${codeSectionLabel}`,
      )
      console.log('[generateCodeV2] prompt', userMessage)

      const result = await generateText({
        model: args.openai.responses('gpt-5.2'),
        system: instructions,
        prompt: userMessage,
        tools: editTools,
        providerOptions: {
          openai: {
            reasoningEffort: 'medium',
          },
        },
      })

      console.log(`[generateCodeV2] iteration ${iteration} finishReason: ${result.finishReason}`)
      console.log(`[generateCodeV2] iteration ${iteration} text: ${result.text}`)
      console.log(`[generateCodeV2] iteration tool calls ${iteration} toolCalls:`, JSON.stringify(result.toolCalls, null, 2))

      const toolCalls = result.toolCalls

      if (toolCalls.length === 0) {
        const allDone = checklist.every((i) => i.done)
        if (allDone) {
          console.log('[generateCodeV2] model done — all checklist items marked done')
          break
        }

        consecutiveNoToolCalls++
        const pending = checklist.filter((i) => !i.done)
        console.log(`[generateCodeV2] no tool calls but ${pending.length} items still pending (consecutive: ${consecutiveNoToolCalls})`)

        if (consecutiveNoToolCalls >= 3) {
          console.warn('[generateCodeV2] giving up — no tool calls in 3 consecutive iterations with items still pending')
          break
        }

        // Inject a reminder entry so the next iteration's history nudges the model
        historyEntries.push({
          round: iteration,
          sequenceNum: toolCallSequence++,
          toolName: 'REMINDER',
          briefArgs: '',
          output: `You stopped making tool calls but these checklist items are NOT done yet:\n${pending.map((i) => `- \`${i.id}\`: ${i.description}`).join('\n')}\nPlease continue implementing them. Use apply_patch to make edits. Call markChecklistItemDone when each item is complete.`,
          isViewRange: false,
        })
        continue
      }

      consecutiveNoToolCalls = 0

      // Execute tool calls manually and collect results
      for (const tc of toolCalls) {
        const output = executeToolCall(tc.toolName, tc.input as Record<string, unknown>, state, checklist)
        console.log(`[generateCodeV2] ${tc.toolName}: ${output.substring(0, 200)}`)

        // Build truncated args summary for history
        const inputArgs = tc.input as Record<string, unknown>
        const brief: Record<string, unknown> = {}
        for (const [key, val] of Object.entries(inputArgs)) {
          brief[key] = truncateArg(val)
        }

        historyEntries.push({
          round: iteration,
          sequenceNum: toolCallSequence++,
          toolName: tc.toolName,
          briefArgs: JSON.stringify(brief),
          output,
          isViewRange: tc.toolName === 'view_range',
        })
      }

      // Trim old entries if history grows too large
      if (historyEntries.length > MAX_HISTORY_ENTRIES) {
        const excess = historyEntries.length - MAX_HISTORY_ENTRIES
        historyEntries.splice(0, excess)
        console.log(`[generateCodeV2] trimmed ${excess} old history entries`)
      }

      console.log('[generateCodeV2] current code length:', state.currentCode.split('\n').length, 'lines')
      console.log('[generateCodeV2] checklist progress:', checklist.filter((i) => i.done).length, '/', checklist.length)
    }

    // ---- Validation + repair ----
    console.log('[generateCodeV2] starting validation phase')

    for (let attempt = 1; attempt <= maxValidationAttempts; attempt++) {
      const validation = validateGeneratedSceneCode(state.currentCode, args.renderType)
      if (validation.ok) {
        console.log('[generateCodeV2] validation passed')
        break
      }

      console.log(`[generateCodeV2] validation failed (attempt ${attempt}): ${validation.error.message}`)

      if (attempt === maxValidationAttempts) {
        console.warn('[generateCodeV2] validation failed after all repair attempts')
        return { ok: false, error: validation.error }
      }

      // Ask model to fix validation errors — fresh prompt, same tools
      const fixPrompt = [
        'The code has a validation error. Fix it.',
        '',
        `Error: ${validation.error.phase}: ${validation.error.message}`,
        validation.error.details ? `Details: ${validation.error.details.join(', ')}` : '',
        '',
        '=== CURRENT CODE ===',
        addLineNumbers(state.currentCode),
        '=== END CURRENT CODE ===',
        '',
        referenceBlock,
        '',
        'Fix the error using apply_patch.',
      ].join('\n')

      const fixResult = await generateText({
        model: args.openai.responses('gpt-5.3-codex'),
        system: instructions,
        prompt: fixPrompt,
        tools: editTools,
      })

      const fixCalls = fixResult.toolCalls
      console.log(`[generateCodeV2] repair attempt ${attempt}: ${fixCalls.length} tool calls`)

      for (const fc of fixCalls) {
        const output = executeToolCall(fc.toolName, fc.input as Record<string, unknown>, state, checklist)
        console.log(`[generateCodeV2] repair ${fc.toolName}: ${output.substring(0, 200)}`)
      }
    }
  } catch (error) {
    console.error('[generateCodeV2] agent run failed', error)
  }

  // Final safety validation
  const finalValidation = validateGeneratedSceneCode(state.currentCode, args.renderType)
  if (!finalValidation.ok) {
    console.warn('[generateCodeV2] final code failed validation', finalValidation.error)
    return { ok: false, error: finalValidation.error }
  }

  const completed = checklist.filter((i) => i.done).length
  console.log(`[generateCodeV2] finished: ${completed}/${checklist.length} items completed`)

  return { ok: true, code: state.currentCode, checklist }
}
