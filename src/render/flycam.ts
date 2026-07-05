import { PerspectiveCamera, Vector3 } from 'three/webgpu'

/**
 * Pointer-lock fly camera. WASD move, QE down/up, shift = fast.
 * Render-layer only — never touches sim state (V6).
 */
export class FlyCam {
  readonly camera: PerspectiveCamera
  private readonly keys = new Set<string>()
  private yaw = 0
  private pitch = 0
  private readonly dir = new Vector3()

  constructor(private readonly dom: HTMLElement, aspect: number) {
    this.camera = new PerspectiveCamera(70, aspect, 0.05, 1200) // B32 — 4× world
    this.camera.position.set(20, 15, 20)
    this.yaw = Math.PI * 0.75
    this.pitch = -0.4

    dom.addEventListener('click', () => dom.requestPointerLock())
    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== dom) return
      this.yaw -= e.movementX * 0.002
      this.pitch -= e.movementY * 0.002
      this.pitch = Math.max(-1.55, Math.min(1.55, this.pitch))
    })
    document.addEventListener('keydown', (e) => this.keys.add(e.code))
    document.addEventListener('keyup', (e) => this.keys.delete(e.code))
  }

  update(dt: number): void {
    const speed = (this.keys.has('ShiftLeft') ? 40 : 12) * dt
    const { camera, dir } = this
    camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ')

    dir.set(0, 0, 0)
    if (this.keys.has('KeyW')) dir.z -= 1
    if (this.keys.has('KeyS')) dir.z += 1
    if (this.keys.has('KeyA')) dir.x -= 1
    if (this.keys.has('KeyD')) dir.x += 1
    if (dir.lengthSq() > 0) {
      dir.normalize().applyEuler(camera.rotation)
      camera.position.addScaledVector(dir, speed)
    }
    if (this.keys.has('KeyQ')) camera.position.y -= speed
    if (this.keys.has('KeyE')) camera.position.y += speed
  }
}
