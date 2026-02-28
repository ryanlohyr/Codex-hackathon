import type { NodeProps } from 'reactflow'
import clsx from 'clsx'
import type { VisualizationNodeData } from '../../../types/visualization'
import { useAppStore } from '../../../store/useAppStore'

export function VisualizationNode({ id, data, selected }: NodeProps<VisualizationNodeData>) {
  const theme = useAppStore((state) => state.theme)
  const removeVisualizationNode = useAppStore((state) => state.removeVisualizationNode)

  return (
    <div
      className={clsx(
        'min-w-56 rounded-2xl px-4 py-3 shadow-xl backdrop-blur',
        theme === 'light' && 'border border-slate-200 bg-white/95 shadow-slate-300/60',
        theme === 'dark' && 'border border-white/15 bg-slate-900/90 shadow-black/35',
        selected && (theme === 'light' ? 'border-cyan-400 shadow-cyan-200/70' : 'border-cyan-300/80 shadow-cyan-900/60'),
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={clsx('text-xs uppercase tracking-[0.2em]', theme === 'light' ? 'text-cyan-600' : 'text-cyan-200/70')}>
          Visualization
        </p>
        <button
          type="button"
          onMouseDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
          }}
          onClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            if (window.confirm(`Delete "${data.config.title}"?`)) {
              removeVisualizationNode(id)
            }
          }}
          className={clsx(
            'rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.08em]',
            theme === 'light'
              ? 'bg-rose-100 text-rose-700 hover:bg-rose-200'
              : 'bg-rose-500/20 text-rose-200 hover:bg-rose-500/30',
          )}
          aria-label={`Delete visualization ${data.config.title}`}
          title="Delete node"
        >
          Delete
        </button>
      </div>
      <h3 className={clsx('mt-1 text-base font-semibold', theme === 'light' ? 'text-slate-900' : 'text-slate-100')}>{data.config.title}</h3>
      <p className={clsx('mt-2 text-xs', theme === 'light' ? 'text-slate-600' : 'text-slate-300/80')}>{data.config.summary}</p>
      <p className={clsx('mt-3 text-[11px]', theme === 'light' ? 'text-slate-500' : 'text-slate-400')}>Click to enter immersive view</p>
    </div>
  )
}
