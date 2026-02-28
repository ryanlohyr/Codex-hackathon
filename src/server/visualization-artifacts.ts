import { createServerFn } from '@tanstack/react-start'
import type { VisualizationConfig } from '../types/visualization'
import { getVisualizationArtifactRepository } from './repositories/visualization-artifact-repository'

type SaveVisualizationArtifactRequest = {
  id: string
  config: VisualizationConfig
}

type GetVisualizationArtifactRequest = {
  id: string
}

export const saveVisualizationArtifact = createServerFn({ method: 'POST' })
  .inputValidator((data: SaveVisualizationArtifactRequest) => data)
  .handler(async ({ data }) => {
    const repository = getVisualizationArtifactRepository()
    const now = Date.now()

    const existing = await repository.get(data.id)
    await repository.save({
      id: data.id,
      config: data.config,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    })

    console.log(`[saveVisualizationArtifact] saved id: ${data.id}, title: ${data.config.title}`)

    return { ok: true as const }
  })

export const getVisualizationArtifact = createServerFn({ method: 'POST' })
  .inputValidator((data: GetVisualizationArtifactRequest) => data)
  .handler(async ({ data }) => {
    const repository = getVisualizationArtifactRepository()
    const record = await repository.get(data.id)
    return record
  })

