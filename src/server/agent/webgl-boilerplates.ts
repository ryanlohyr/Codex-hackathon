import type { RenderType } from '../../types/visualization'

export const BoilerplateKey = {
  WEBGL_3D_REAL_GLOBE_V1: 'webgl_3d_real_globe_v1',
  NO_TEMPLATE: 'no_template',
} as const

export type BoilerplateKey = (typeof BoilerplateKey)[keyof typeof BoilerplateKey]

export type SceneBoilerplate = {
  key: BoilerplateKey
  renderType: RenderType
  name: string
  whenToUse: string
  code: string
}

const WEBGL_3D_REAL_GLOBE_V1 = `function Scene() {
  var earthRef = React.useRef(null);
  var atmosphereRef = React.useRef(null);
  var cloudsRef = React.useRef(null);
  var params = runtimeState.params || (runtimeState.params = {});
  var spinSpeed = typeof params.spinSpeed === "number" ? params.spinSpeed : 0.12;
  var cloudOpacity = typeof params.cloudOpacity === "number" ? params.cloudOpacity : 0.45;
  if (params.spinSpeed == null) params.spinSpeed = spinSpeed;
  if (params.cloudOpacity == null) params.cloudOpacity = cloudOpacity;

  var cloudData = React.useMemo(function () {
    var count = 1800;
    var positions = new Float32Array(count * 3);
    for (var i = 0; i < count; i++) {
      var u = Math.random();
      var v = Math.random();
      var theta = 2 * Math.PI * u;
      var phi = Math.acos(2 * v - 1);
      var radius = 2.08 + (Math.random() - 0.5) * 0.03;
      positions[i * 3] = radius * Math.sin(phi) * Math.cos(theta);
      positions[i * 3 + 1] = radius * Math.cos(phi);
      positions[i * 3 + 2] = radius * Math.sin(phi) * Math.sin(theta);
    }
    return { count: count, positions: positions };
  }, []);

  function latLonToXYZ(lat, lon, radius) {
    var phi = (90 - lat) * (Math.PI / 180);
    var theta = (lon + 180) * (Math.PI / 180);
    var x = -(radius * Math.sin(phi) * Math.cos(theta));
    var y = radius * Math.cos(phi);
    var z = radius * Math.sin(phi) * Math.sin(theta);
    return [x, y, z];
  }

  helpers.useFrame(function (_, delta) {
    if (runtimeState.toggles && runtimeState.toggles.isPaused) return;
    var speed = typeof runtimeState.params.spinSpeed === "number" ? runtimeState.params.spinSpeed : spinSpeed;
    if (earthRef.current) earthRef.current.rotation.y += delta * speed;
    if (cloudsRef.current) cloudsRef.current.rotation.y += delta * (speed * 1.25);
    if (atmosphereRef.current) atmosphereRef.current.rotation.y += delta * (speed * 0.7);
  });

  return React.createElement(
    React.Fragment,
    null,
    React.createElement("ambientLight", { intensity: 0.34 }),
    React.createElement("directionalLight", {
      position: [5.2, 3.1, 4.2],
      intensity: 1.2,
      color: "#fff4d6"
    }),
    React.createElement("directionalLight", {
      position: [-4.5, -2.5, -3.8],
      intensity: 0.28,
      color: "#9ad9ff"
    }),
    React.createElement(
      "group",
      { ref: earthRef, position: [0, 0, 0] },
      React.createElement(
        "mesh",
        null,
        React.createElement("sphereGeometry", { args: [2, 96, 96] }),
        React.createElement("meshStandardMaterial", {
          color: "#2a6fa8",
          roughness: 0.86,
          metalness: 0.04
        })
      ),
      React.createElement(
        "mesh",
        { ref: atmosphereRef, scale: [1.035, 1.035, 1.035] },
        React.createElement("sphereGeometry", { args: [2, 64, 64] }),
        React.createElement("meshStandardMaterial", {
          color: "#9bd7ff",
          emissive: "#7fd6ff",
          emissiveIntensity: 0.22,
          transparent: true,
          opacity: 0.16,
          roughness: 0.2,
          metalness: 0
        })
      ),
      React.createElement(
        "points",
        { ref: cloudsRef },
        React.createElement(
          "bufferGeometry",
          null,
          React.createElement("bufferAttribute", {
            attach: "attributes-position",
            count: cloudData.count,
            array: cloudData.positions,
            itemSize: 3
          })
        ),
        React.createElement("pointsMaterial", {
          color: "#ffffff",
          size: 0.03,
          transparent: true,
          opacity: runtimeState.params.cloudOpacity,
          depthWrite: false
        })
      )
    ),
    React.createElement(helpers.InfoPoint, {
      label: "EQUATOR",
      explanation: "The equator divides Earth into the Northern and Southern Hemispheres.",
      position: latLonToXYZ(0, 0, 2.34),
      color: "#f59e0b"
    }),
    React.createElement(helpers.InfoPoint, {
      label: "NORTH POLE",
      explanation: "Earth's rotational axis points through the poles, driving seasonal sun-angle changes.",
      position: latLonToXYZ(86, 0, 2.34),
      color: "#7dd3fc"
    }),
    React.createElement(helpers.InfoPoint, {
      label: "PACIFIC BASIN",
      explanation: "The Pacific is Earth's largest ocean basin and strongly affects climate circulation.",
      position: latLonToXYZ(10, -150, 2.34),
      color: "#38bdf8"
    })
  );
}
return Scene;`

export const SCENE_BOILERPLATES: SceneBoilerplate[] = [
  {
    key: BoilerplateKey.WEBGL_3D_REAL_GLOBE_V1,
    renderType: '3D_WEBGL',
    name: 'Real Globe Starter',
    whenToUse:
      'Earth, world map, geography, climate zones, latitude/longitude, tectonics, global circulation.',
    code: WEBGL_3D_REAL_GLOBE_V1,
  },
]

export function getSceneBoilerplate(key: string, renderType: RenderType): SceneBoilerplate | null {
  return SCENE_BOILERPLATES.find((item) => item.key === key && item.renderType === renderType) ?? null
}

export function formatBoilerplatesForPrompt(renderType: RenderType): string {
  const items = SCENE_BOILERPLATES.filter((item) => item.renderType === renderType)
  if (items.length === 0) {
    return 'No boilerplates available for this render type.'
  }

  return items
    .map((item) => `- ${item.key}: ${item.name}. Use for: ${item.whenToUse}`)
    .join('\n')
}

