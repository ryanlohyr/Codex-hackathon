const COLUMN_COUNT = 4
const X_GAP = 280
const Y_GAP = 210

export function getVisualizationNodePosition(index: number) {
  const row = Math.floor(index / COLUMN_COUNT)
  const col = index % COLUMN_COUNT

  return {
    x: col * X_GAP + (row % 2) * 80,
    y: row * Y_GAP,
  }
}
