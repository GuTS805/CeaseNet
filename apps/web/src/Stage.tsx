import loadMujoco from "@mujoco/mujoco"
import { useEffect, useRef, useState } from "react"
import * as THREE from "three"
import { RobotSim } from "@ceasenet/sim"
import { statusColour } from "./lib"

export interface StagePose {
  id: number
  q: ArrayLike<number>
  status?: string
}

const CELL_SPACING = 1.12

const COLOURS: Record<string, number> = { green: 0x22c55e, amber: 0xf59e0b, red: 0xef4444, grey: 0x6b7280 }

let mujocoPromise: Promise<unknown> | undefined
export const getMujoco = () => (mujocoPromise ??= loadMujoco())

/** Builds three.js meshes from the simulator's own model, so what you see is what is simulated. */
function buildCell(sim: RobotSim, offsetY: number, scene: THREE.Scene) {
  const m = sim.model
  const meshes: (THREE.Mesh | undefined)[] = []
  for (let i = 0; i < m.ngeom; i++) {
    const type = m.geom_type[i]
    const [a, b, c] = [m.geom_size[3 * i], m.geom_size[3 * i + 1], m.geom_size[3 * i + 2]] as [number, number, number]
    let geometry: THREE.BufferGeometry | undefined
    if (type === 2) geometry = new THREE.SphereGeometry(a, 24, 16)
    else if (type === 3) geometry = new THREE.CapsuleGeometry(a, 2 * b, 8, 16).rotateX(Math.PI / 2)
    else if (type === 5) geometry = new THREE.CylinderGeometry(a, a, 2 * b, 28).rotateX(Math.PI / 2)
    else if (type === 6) geometry = new THREE.BoxGeometry(2 * a, 2 * b, 2 * c)
    if (!geometry) {
      meshes.push(undefined)
      continue
    }
    const colour = new THREE.Color(m.geom_rgba[4 * i], m.geom_rgba[4 * i + 1], m.geom_rgba[4 * i + 2])
    const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: colour, roughness: 0.55, metalness: 0.1 }))
    mesh.matrixAutoUpdate = false
    mesh.castShadow = true
    mesh.receiveShadow = true
    scene.add(mesh)
    meshes.push(mesh)
  }
  const matrix = new THREE.Matrix4()
  const update = () => {
    const pos = sim.data.geom_xpos
    const mat = sim.data.geom_xmat
    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i]
      if (!mesh) continue
      const r = 9 * i
      const p = 3 * i
      matrix.set(
        mat[r], mat[r + 1], mat[r + 2], pos[p],
        mat[r + 3], mat[r + 4], mat[r + 5], pos[p + 1] + offsetY,
        mat[r + 6], mat[r + 7], mat[r + 8], pos[p + 2],
        0, 0, 0, 1,
      )
      mesh.matrix.copy(matrix)
    }
  }
  return { meshes, update }
}

/**
 * Draws up to three work cells. It runs no physics: it shows poses handed to it, whether those come
 * live from the robots or from a replay.
 */
export function Stage({ poses, count = 3 }: { poses: () => StagePose[]; count?: number }) {
  const host = useRef<HTMLDivElement>(null)
  const posesRef = useRef(poses)
  posesRef.current = poses
  const [problem, setProblem] = useState<string>()

  useEffect(() => {
    let disposed = false
    let cleanup = () => {}
    ;(async () => {
      const mujoco = await getMujoco()
      if (disposed || !host.current) return
      const el = host.current
      const sim = new RobotSim(mujoco)
      const ledGeom = (mujoco as any).mj_name2id(sim.model, (mujoco as any).mjtObj.mjOBJ_GEOM.value, "led") as number

      const scene = new THREE.Scene()
      scene.background = new THREE.Color(0x0a1019)
      scene.add(new THREE.HemisphereLight(0xdbe7ff, 0x1a2230, 1.5))
      const sun = new THREE.DirectionalLight(0xffffff, 2)
      sun.position.set(1.5, 2.5, 4)
      scene.add(sun)

      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(10, 12),
        new THREE.MeshStandardMaterial({ color: 0x141c28, roughness: 0.95 }),
      )
      scene.add(floor)

      const ids = Array.from({ length: count }, (_, i) => i + 1)
      const cells = new Map(ids.map((id, i) => [id, buildCell(sim, (i - (count - 1) / 2) * CELL_SPACING, scene)]))

      const camera = new THREE.PerspectiveCamera(36, 1, 0.05, 40)
      camera.up.set(0, 0, 1)
      const placeCamera = (aspect: number) => {
        camera.aspect = aspect
        // From the table side, so the arms face the viewer and nothing hides the boxes. Robot 1 is on the left.
        const width = count * CELL_SPACING + 0.15
        const halfFov = (camera.fov * Math.PI) / 360
        const distance = Math.max(1.9, width / (2 * Math.tan(halfFov) * aspect))
        camera.position.set(0.28 + distance * 0.84, 0, 0.3 + distance * 0.54)
        camera.lookAt(0.28, 0, 0.3)
        camera.updateProjectionMatrix()
      }

      let renderer: THREE.WebGLRenderer
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true })
      } catch {
        setProblem("This browser could not start 3D graphics.")
        return
      }
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
      el.appendChild(renderer.domElement)

      const resize = () => {
        const { clientWidth: w, clientHeight: h } = el
        if (w === 0 || h === 0) return
        renderer.setSize(w, h)
        placeCamera(w / h)
      }
      const observer = new ResizeObserver(resize)
      observer.observe(el)
      resize()

      let frame = 0
      const draw = () => {
        frame = requestAnimationFrame(draw)
        for (const pose of posesRef.current()) {
          const cell = cells.get(pose.id)
          if (!cell) continue
          sim.showPose(pose.q)
          cell.update()
          const led = cell.meshes[ledGeom]
          if (led) {
            const colour = COLOURS[statusColour(pose.status as any)] ?? COLOURS.grey!
            const material = led.material as THREE.MeshStandardMaterial
            material.color.setHex(colour)
            material.emissive.setHex(colour)
            material.emissiveIntensity = 0.9
          }
        }
        renderer.render(scene, camera)
      }
      draw()

      cleanup = () => {
        cancelAnimationFrame(frame)
        observer.disconnect()
        renderer.dispose()
        renderer.domElement.remove()
      }
    })().catch((e) => setProblem((e as Error).message))
    return () => {
      disposed = true
      cleanup()
    }
  }, [count])

  return (
    <div ref={host} style={{ position: "absolute", inset: 0 }}>
      {problem && <div className="stage-note">{problem}</div>}
    </div>
  )
}
