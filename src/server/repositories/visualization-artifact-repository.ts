import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { VisualizationConfig } from '../../types/visualization'
import { SCENE_BOILERPLATES } from '../agent/webgl-boilerplates'

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
    if (STUB_RECORDS[id]) {
      console.log(`[repo] returning stub record for id: ${id}`)
      return STUB_RECORDS[id]
    }
    try {
      const raw = await readFile(artifactFilePath(id), 'utf8')
      return JSON.parse(raw) as VisualizationArtifactRecord
    } catch {
      return null
    }
  }
}

// Stub record: hitting id "globe-stub" returns the real globe boilerplate
const GLOBE_BOILERPLATE = SCENE_BOILERPLATES.find((b) => b.key === 'webgl_3d_real_globe_v1')
const STUB_RECORDS: Record<string, VisualizationArtifactRecord> = {
  'globe-stub': {
    id: 'globe-stub',
    config: {
      type: 'terrain',
      renderType: '3D_WEBGL',
      theme: 'dark',
      title: 'Globe Boilerplate Stub',
      summary: 'Stub visualization pre-loaded with the real globe boilerplate template.',
      params: { spinSpeed: 0.12, cloudOpacity: 0.45 },
      generatedSceneCode: GLOBE_BOILERPLATE?.code ?? '',
      controls: {
        title: 'GLOBE CONTROLS',
        sliders: [
          { key: 'spinSpeed', label: 'Spin Speed', min: 0, max: 1, step: 0.01, defaultValue: 0.12 },
          { key: 'cloudOpacity', label: 'Cloud Opacity', min: 0, max: 1, step: 0.01, defaultValue: 0.45 },
        ],
        toggles: [{ key: 'isPaused', label: 'Pause', defaultValue: false }],
      },
    },
    createdAt: 0,
    updatedAt: 0,
  },
}

let singletonRepository: VisualizationArtifactRepository | null = null

export function getVisualizationArtifactRepository(): VisualizationArtifactRepository {
  if (!singletonRepository) {
    singletonRepository = new FileVisualizationArtifactRepository()
  }
  return singletonRepository
}

