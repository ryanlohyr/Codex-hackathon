import { createFileRoute } from '@tanstack/react-router'
import { MindCanvasFlow } from '../components/graph/MindCanvasFlow'

function GraphPage() {
  return <MindCanvasFlow />
}

export const Route = createFileRoute('/')({
  component: GraphPage,
})
