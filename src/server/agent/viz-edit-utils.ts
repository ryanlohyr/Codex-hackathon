import type { FunctionTool } from 'openai/resources/responses/responses'

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

export function addLineNumbers(code: string): string {
  return code
    .split('\n')
    .map((line, i) => `${i + 1} | ${line}`)
    .join('\n')
}

export function formatChecklist(items: ChecklistItem[]): string {
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

export function findAndReplace(
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

export const SKELETON_THRESHOLD = 200

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

export function generateSkeleton(code: string): string {
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

export const editTools: FunctionTool[] = [
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

export function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  state: { currentCode: string },
  checklist: ChecklistItem[],
  logPrefix: string = '[v4]',
): string {
  if (toolName === 'find_and_replace') {
    const { old_string, new_string } = args as { old_string: string; new_string: string }
    const result = findAndReplace(state.currentCode, old_string, new_string)
    if (!result.ok) {
      return JSON.stringify({ success: false, error: (result as { ok: false; error: string }).error })
    }
    state.currentCode = (result as { ok: true; code: string }).code
    const lineCount = state.currentCode.split('\n').length
    console.log(`${logPrefix} find_and_replace: ok (${lineCount} lines)`)
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
      `${logPrefix} view_range: lines ${start_line}-${clampedEnd}${wasCapped ? ' [capped]' : ''}`,
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
      console.log(`${logPrefix} search_code: no matches for "${pattern}"`)
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

    console.log(`${logPrefix} search_code: ${matchIndices.length} matches for "${pattern}"`)
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
    console.log(`${logPrefix} markChecklistItemDone: ${id}`)
    return JSON.stringify({ success: true, id, done: true })
  }

  return JSON.stringify({ success: false, error: `Unknown tool: ${toolName}` })
}

// ---------------------------------------------------------------------------
// Code state formatting — full or skeleton depending on length
// ---------------------------------------------------------------------------

export function formatCodeState(code: string): { label: string; content: string } {
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
