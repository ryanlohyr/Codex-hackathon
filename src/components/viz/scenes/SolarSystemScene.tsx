import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Billboard, OrbitControls, Text } from '@react-three/drei'
import type { Group } from 'three'
import type {
  CueTarget,
  VisualizationConfig,
  VisualizationCue,
  VisualizationRuntimeState,
} from '../../../types/visualization'

type SolarSystemSceneProps = {
  config: VisualizationConfig
  runtimeState: VisualizationRuntimeState
}

type Planet = {
  id: Extract<CueTarget, 'mercury' | 'venus' | 'earth'>
  name: string
  distance: number
  size: number
  color: string
  speed: number
}

const PLANETS: Planet[] = [
  { id: 'mercury', name: 'Mercury', distance: 2.4, size: 0.18, color: '#9CA3AF', speed: 1.8 },
  { id: 'venus', name: 'Venus', distance: 3.7, size: 0.3, color: '#E5C07B', speed: 1.2 },
  { id: 'earth', name: 'Earth', distance: 5.1, size: 0.34, color: '#4DA3FF', speed: 0.8 },
]

function cueColor(cue: VisualizationCue) {
  return cue.color ?? '#22d3ee'
}

export function SolarSystemScene({ config, runtimeState }: SolarSystemSceneProps) {
  const orbitRefs = useRef<Array<Group | null>>([])

  const mergedParams = {
    ...config.params,
    ...runtimeState.params,
  }

  const speedMultiplier =
    typeof mergedParams.speedMultiplier === 'number' ? mergedParams.speedMultiplier : 1
  const sunColor = typeof mergedParams.sunColor === 'string' ? mergedParams.sunColor : '#f9c74f'

  const toggles = runtimeState.toggles
  const showLabels = toggles.showLabels ?? true
  const showOrbitRings = toggles.showOrbitRings ?? true
  const showSpeedLabels = toggles.showSpeedLabels ?? false
  const showCues = toggles.showCues ?? true

  const cuesByTarget = useMemo(() => {
    const index: Record<CueTarget, VisualizationCue[]> = {
      sun: [],
      mercury: [],
      venus: [],
      earth: [],
      system: [],
    }

    for (const cue of runtimeState.cues) {
      if (cue.visible === false) continue
      index[cue.target].push(cue)
    }

    return index
  }, [runtimeState.cues])

  useFrame((_, delta) => {
    const t = delta * speedMultiplier
    orbitRefs.current.forEach((ref, index) => {
      if (!ref) return
      ref.rotation.y += t * PLANETS[index].speed
    })
  })

  return (
    <>
      <ambientLight intensity={0.3} />
      <pointLight position={[0, 0, 0]} intensity={25} color={sunColor} />

      <mesh>
        <sphereGeometry args={[1, 48, 48]} />
        <meshStandardMaterial emissive={sunColor} emissiveIntensity={1} color={sunColor} />
      </mesh>

      {showLabels && (
        <Billboard position={[0, 1.45, 0]} follow>
          <Text color="#f8fafc" fontSize={0.24} anchorX="center" anchorY="middle">
            Sun
          </Text>
        </Billboard>
      )}

      {showCues &&
        cuesByTarget.sun.map((cue, index) => (
          <Billboard key={cue.id} position={[0, 1.9 + index * 0.24, 0]} follow>
            <Text color={cueColor(cue)} fontSize={0.16} anchorX="center" anchorY="middle">
              {cue.label}
            </Text>
          </Billboard>
        ))}

      {PLANETS.map((planet, index) => (
        <group
          key={planet.id}
          ref={(element) => {
            orbitRefs.current[index] = element
          }}
        >
          {showOrbitRings && (
            <mesh rotation-x={-Math.PI / 2}>
              <ringGeometry args={[planet.distance - 0.01, planet.distance + 0.01, 128]} />
              <meshBasicMaterial color="#334155" opacity={0.45} transparent />
            </mesh>
          )}

          <mesh position={[planet.distance, 0, 0]}>
            <sphereGeometry args={[planet.size, 24, 24]} />
            <meshStandardMaterial color={planet.color} />
          </mesh>

          {showLabels && (
            <Billboard position={[planet.distance, planet.size + 0.22, 0]} follow>
              <Text color="#e2e8f0" fontSize={0.18} anchorX="center" anchorY="middle">
                {planet.name}
              </Text>
            </Billboard>
          )}

          {showSpeedLabels && (
            <Billboard position={[planet.distance, planet.size + 0.45, 0]} follow>
              <Text color="#94a3b8" fontSize={0.14} anchorX="center" anchorY="middle">
                {`${planet.speed.toFixed(1)}x orbit speed`}
              </Text>
            </Billboard>
          )}

          {showCues &&
            cuesByTarget[planet.id].map((cue, cueIndex) => (
              <group key={cue.id}>
                <Billboard
                  position={[planet.distance, planet.size + 0.72 + cueIndex * 0.2, 0]}
                  follow
                >
                  <Text color={cueColor(cue)} fontSize={0.14} anchorX="center" anchorY="middle">
                    {cue.label}
                  </Text>
                </Billboard>

                {cue.kind === 'highlight' && (
                  <mesh position={[planet.distance, 0, 0]} rotation-x={-Math.PI / 2}>
                    <ringGeometry args={[planet.size + 0.1, planet.size + 0.14, 64]} />
                    <meshBasicMaterial color={cueColor(cue)} transparent opacity={0.9} />
                  </mesh>
                )}
              </group>
            ))}
        </group>
      ))}

      {showLabels && (
        <Billboard position={[0, -2.1, 0]} follow>
          <Text color="#94a3b8" fontSize={0.14} anchorX="center" anchorY="middle">
            Mercury • Venus • Earth
          </Text>
        </Billboard>
      )}

      {showCues && cuesByTarget.system.length > 0 && (
        <Billboard position={[0, -2.45, 0]} follow>
          <Text color="#22d3ee" fontSize={0.12} anchorX="center" anchorY="middle">
            {cuesByTarget.system.map((cue) => cue.label).join(' | ')}
          </Text>
        </Billboard>
      )}

      <OrbitControls enablePan={false} minDistance={4} maxDistance={14} />
    </>
  )
}
