import { useMemo, type MouseEvent } from 'react'
import { useNavigate } from '@tanstack/react-router'
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  type Node,
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from 'reactflow'
import { useAppStore } from '../../store/useAppStore'
import { VisualizationNode } from './nodes/VisualizationNode'
import type { VisualizationNodeData } from '../../types/visualization'

export function MindCanvasFlow() {
  const navigate = useNavigate()
  const theme = useAppStore((state) => state.theme)
  const nodes = useAppStore((state) => state.nodes)
  const edges = useAppStore((state) => state.edges)
  const setNodes = useAppStore((state) => state.setNodes)
  const setEdges = useAppStore((state) => state.setEdges)
  const setActiveVisualization = useAppStore((state) => state.setActiveVisualization)

  const nodeTypes = useMemo<NodeTypes>(() => ({ visualizationNode: VisualizationNode }), [])

  const onNodesChange = (changes: NodeChange[]) => {
    setNodes((currentNodes) => applyNodeChanges(changes, currentNodes))
  }

  const onEdgesChange = (changes: EdgeChange[]) => {
    setEdges((currentEdges) => applyEdgeChanges(changes, currentEdges))
  }

  const onNodeClick = (_event: MouseEvent, node: Node<VisualizationNodeData>) => {
    if (node.type !== 'visualizationNode') {
      return
    }

    setActiveVisualization(node.id)
    navigate({
      to: '/viz/$id',
      params: { id: node.id },
    })
  }

  return (
    <div className={theme === 'light' ? 'h-full w-full bg-slate-50' : 'h-full w-full bg-slate-950'}>
      <ReactFlow
        fitView
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        proOptions={{ hideAttribution: true }}
      >
        <Background color={theme === 'light' ? '#94a3b8' : '#334155'} gap={28} size={1.2} />
        <MiniMap
          pannable
          zoomable
          style={{
            background: theme === 'light' ? '#ffffff' : '#0f172a',
            border:
              theme === 'light'
                ? '1px solid rgba(15,23,42,0.18)'
                : '1px solid rgba(255,255,255,0.14)',
          }}
        />
        <Controls />
      </ReactFlow>
    </div>
  )
}
