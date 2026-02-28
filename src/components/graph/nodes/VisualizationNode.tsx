import type { NodeProps } from 'reactflow'
import clsx from 'clsx'
import type { VisualizationNodeData } from '../../../types/visualization'
import { useAppStore } from '../../../store/useAppStore'

export function VisualizationNode({ data, selected }: NodeProps<VisualizationNodeData>) {
  const theme = useAppStore((state) => state.theme)

  return (
    <div
      className={clsx(
        'min-w-56 rounded-2xl px-4 py-3 shadow-xl backdrop-blur',
        theme === 'light' && 'border border-slate-200 bg-white/95 shadow-slate-300/60',
        theme === 'dark' && 'border border-white/15 bg-slate-900/90 shadow-black/35',
        selected && (theme === 'light' ? 'border-cyan-400 shadow-cyan-200/70' : 'border-cyan-300/80 shadow-cyan-900/60'),
      )}
    >
      <p className={clsx('text-xs uppercase tracking-[0.2em]', theme === 'light' ? 'text-cyan-600' : 'text-cyan-200/70')}>Visualization</p>
      <h3 className={clsx('mt-1 text-base font-semibold', theme === 'light' ? 'text-slate-900' : 'text-slate-100')}>{data.config.title}</h3>
      <p className={clsx('mt-2 text-xs', theme === 'light' ? 'text-slate-600' : 'text-slate-300/80')}>{data.config.summary}</p>
      <p className={clsx('mt-3 text-[11px]', theme === 'light' ? 'text-slate-500' : 'text-slate-400')}>Click to enter immersive view</p>
    </div>
  )
}
