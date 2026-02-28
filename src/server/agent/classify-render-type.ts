// TODO: Re-enable 2D classification when Canvas 2D is ready
// import { generateObject } from 'ai'
import type { createOpenAI } from '@ai-sdk/openai'
// import { z } from 'zod'
import type { RenderType } from '../../types/visualization'

// const classificationSchema = z
//   .object({
//     renderType: z.enum(['3D_WEBGL', '2D_CANVAS']),
//     reasoning: z.string(),
//   })
//   .strict()

// const CLASSIFICATION_SYSTEM_PROMPT = `You are an intelligent rendering router for an educational visualization platform.
//
// Your job is to classify a user's visualization request into exactly one of two rendering modes:
//
// "3D_WEBGL" — Use this for:
//   - Spatial, physical, or volumetric environments (solar systems, molecules, terrain, architecture)
//   - Multi-variable simulations that benefit from depth (gravity, fluid dynamics, particle systems)
//   - Anything the user explicitly describes as "3D", "scene", or "world"
//
// "2D_CANVAS" — Use this for:
//   - Mathematical plots and graphs (sine waves, parabolas, function plots)
//   - Neural network architecture diagrams
//   - Flat node-graphs, flowcharts, state machines, and tree diagrams
//   - Timelines, bar charts, scatter plots, and statistical visualizations
//   - Circuit diagrams, algorithm visualizations (sorting, pathfinding)
//   - Anything the user explicitly describes as "2D", "plot", "chart", "graph", or "diagram"
//
// When ambiguous, prefer 3D_WEBGL for physical/spatial concepts and 2D_CANVAS for abstract/mathematical concepts.
//
// Return a JSON object with:
// - renderType: strictly "3D_WEBGL" or "2D_CANVAS"
// - reasoning: a brief one-sentence explanation of why you chose this mode`

export async function classifyRenderType(args: {
  openai: ReturnType<typeof createOpenAI>
  prompt: string
}): Promise<RenderType> {
  // TODO: Re-enable 2D classification when Canvas 2D is ready
  // try {
  //   const { object } = await generateObject({
  //     model: args.openai.responses('gpt-4o-mini'),
  //     schema: classificationSchema,
  //     schemaName: 'render_type_classification',
  //     system: CLASSIFICATION_SYSTEM_PROMPT,
  //     prompt: args.prompt,
  //   })
  //
  //   console.log('[classifyRenderType]', {
  //     prompt: args.prompt,
  //     renderType: object.renderType,
  //     reasoning: object.reasoning,
  //   })
  //
  //   return object.renderType
  // } catch (error) {
  //   console.error('[classifyRenderType] classification failed, defaulting to 3D_WEBGL', error)
  //   return '3D_WEBGL'
  // }

  console.log('[classifyRenderType] hardcoded to 3D_WEBGL', { prompt: args.prompt })
  return '3D_WEBGL'
}
