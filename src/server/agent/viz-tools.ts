import { tool } from 'ai'
import { z } from 'zod'
import type { VisualizationCommand } from '../../types/visualization'

const cueTargetSchema = z.enum(['sun', 'mercury', 'venus', 'earth', 'system'])
const cueKindSchema = z.enum(['label', 'highlight', 'note'])

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.object({}).catchall(jsonValueSchema),
  ]),
)

export const vizTools = {
  set_param: tool({
    description: 'Set a parameter value on the active visualization',
    inputSchema: z.object({ key: z.string(), value: jsonValueSchema }),
  }),
  set_toggle: tool({
    description: 'Enable or disable a toggle on the active visualization',
    inputSchema: z.object({ name: z.string(), enabled: z.boolean() }),
  }),
  upsert_cue: tool({
    description: 'Add or update a cue (label, highlight, or note) on the visualization',
    inputSchema: z.object({
      cue: z
        .object({
          id: z.string(),
          label: z.string(),
          target: cueTargetSchema,
          kind: cueKindSchema,
          color: z.string().nullable(),
          note: z.string().nullable(),
          visible: z.boolean().nullable(),
        }),
    }),
  }),
  remove_cue: tool({
    description: 'Remove a cue from the visualization by ID',
    inputSchema: z.object({ id: z.string() }),
  }),
  clear_cues: tool({
    description: 'Remove all cues from the visualization',
    inputSchema: z.object({}),
  }),
  // edit_code: tool({
  //   description:
  //     'Edit the generated scene code of the active visualization. Use this when the user wants to change visual appearance, behavior, colors, shapes, animations, layout, or any aspect of how the visualization looks or works.',
  //   inputSchema: z.object({
  //     instruction: z
  //       .string()
  //       .describe('Description of what to change in the visualization code'),
  //   }),
  // }),
}

export function parseToolCall(name: string, args: Record<string, unknown>): VisualizationCommand | null {
  switch (name) {
    case 'set_param':
      return { action: 'set_param', payload: args as { key: string; value: unknown } }
    case 'set_toggle':
      return { action: 'set_toggle', payload: args as { name: string; enabled: boolean } }
    case 'upsert_cue': {
      const cue = (args as { cue: Record<string, unknown> }).cue
      return {
        action: 'upsert_cue',
        payload: {
          cue: {
            id: cue.id as string,
            label: cue.label as string,
            target: cue.target as 'sun' | 'mercury' | 'venus' | 'earth' | 'system',
            kind: cue.kind as 'label' | 'highlight' | 'note',
            color: (cue.color as string | null) ?? undefined,
            note: (cue.note as string | null) ?? undefined,
            visible: (cue.visible as boolean | null) ?? undefined,
          },
        },
      }
    }
    case 'remove_cue':
      return { action: 'remove_cue', payload: args as { id: string } }
    case 'clear_cues':
      return { action: 'clear_cues', payload: {} }
    default:
      return null
  }
}
