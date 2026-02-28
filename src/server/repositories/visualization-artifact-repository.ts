import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { VisualizationConfig } from '../../types/visualization'

export type VisualizationArtifactRecord = {
  id: string
  config: VisualizationConfig
  createdAt: number
  updatedAt: number
}

export interface VisualizationArtifactRepository {
  save(record: VisualizationArtifactRecord): Promise<void>
  get(id: string): Promise<VisualizationArtifactRecord | null>
}

const ARTIFACTS_DIR = path.join(process.cwd(), 'data', 'visualizations')

function artifactFilePath(id: string): string {
  return path.join(ARTIFACTS_DIR, `${id}.json`)
}

export class FileVisualizationArtifactRepository
  implements VisualizationArtifactRepository
{
  async save(record: VisualizationArtifactRecord): Promise<void> {
    await mkdir(ARTIFACTS_DIR, { recursive: true })
    await writeFile(artifactFilePath(record.id), JSON.stringify(record, null, 2), 'utf8')
  }

  async get(id: string): Promise<VisualizationArtifactRecord | null> {
    try {
      const raw = await readFile(artifactFilePath(id), 'utf8')
      return JSON.parse(raw) as VisualizationArtifactRecord
    } catch {
      return null
    }
  }
}

let singletonRepository: VisualizationArtifactRepository | null = null

export function getVisualizationArtifactRepository(): VisualizationArtifactRepository {
  if (!singletonRepository) {
    singletonRepository = new FileVisualizationArtifactRepository()
  }
  return singletonRepository
}

