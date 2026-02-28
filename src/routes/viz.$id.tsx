import { useEffect } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import clsx from 'clsx'
import { InteractiveVisualizer } from '../components/viz/InteractiveVisualizer'
import { getVisualizationArtifact } from '../server/visualization-artifacts'
import { useAppStore } from '../store/useAppStore'

function VisualizationPage() {
  const { id } = Route.useParams()
  const nodes = useAppStore((state) => state.nodes)
  const setActiveVisualization = useAppStore((state) => state.setActiveVisualization)
  const upsertVisualizationNodeConfig = useAppStore((state) => state.upsertVisualizationNodeConfig)
  const activeVisualizationState = useAppStore((state) => state.activeVisualizationState)

  const node = nodes.find((entry) => entry.id === id)
  const vizTheme = node?.type === 'visualizationNode' ? (node.data.config.theme ?? 'dark') : 'dark'
  const isLight = vizTheme === 'light'

  useEffect(() => {
    setActiveVisualization(id)
  }, [id, setActiveVisualization])

  useEffect(() => {
    let isMounted = true

    const hydrateFromBackend = async () => {
      const record = await getVisualizationArtifact({ data: { id } })
      if (!isMounted || !record) return
      upsertVisualizationNodeConfig(id, record.config)
    }

    void hydrateFromBackend()

    return () => {
      isMounted = false
    }
  }, [id, upsertVisualizationNodeConfig])

  if (!node || node.type !== 'visualizationNode') {
    return (
      <div className="grid h-full w-full place-items-center bg-slate-950 text-slate-100">
        <div className="space-y-4 text-center">
          <p className="text-sm uppercase tracking-[0.2em] text-slate-400">Visualization</p>
          <h1 className="text-2xl font-semibold">Visualization not found</h1>
          <Link to="/" className="text-cyan-300 hover:text-cyan-200">
            Return to canvas
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="relative h-full w-full">
      <InteractiveVisualizer config={node.data.config} runtimeState={activeVisualizationState} />
      <Link
        to="/"
        className={clsx(
          'absolute bottom-4 left-4 z-40 rounded-lg border px-3 py-2 text-sm font-semibold backdrop-blur',
          isLight
            ? 'border-black/10 bg-white/80 text-slate-700 hover:bg-white/90'
            : 'border-white/20 bg-slate-900/80 text-slate-100 hover:bg-slate-800',
        )}
      >
        Back to mindmap
      </Link>
    </div>
  )
}

export const Route = createFileRoute('/viz/$id')({
  component: VisualizationPage,
})
