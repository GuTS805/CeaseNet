export type SoundName = "leak" | "press" | "wave" | "snap" | "refused" | "receipt" | "clear" | "erase" | "asks"

const STORAGE_KEY = "ceasenet.sound"
const VOLUME = 0.7

/** Every sound is made in the browser, so the site loads no audio files. Browsers allow sound only after the first click. */
export class WarSound {
  muted: boolean
  private ctx: AudioContext | undefined
  private master: GainNode | undefined
  private hum: { gain: GainNode; sources: OscillatorNode[] } | undefined

  constructor() {
    this.muted = globalThis.localStorage?.getItem(STORAGE_KEY) === "off"
  }

  unlock(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext()
      this.master = this.ctx.createGain()
      this.master.gain.value = this.muted ? 0 : VOLUME
      this.master.connect(this.ctx.destination)
    }
    void this.ctx.resume()
  }

  toggle(): boolean {
    this.muted = !this.muted
    globalThis.localStorage?.setItem(STORAGE_KEY, this.muted ? "off" : "on")
    if (this.master) this.master.gain.value = this.muted ? 0 : VOLUME
    return this.muted
  }

  private tone(from: number, to: number, ms: number, gain: number, type: OscillatorType = "sine", delayMs = 0): void {
    const { ctx, master } = this
    if (!ctx || !master) return
    const start = ctx.currentTime + delayMs / 1000
    const end = start + ms / 1000
    const osc = ctx.createOscillator()
    const env = ctx.createGain()
    osc.type = type
    osc.frequency.setValueAtTime(from, start)
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), end)
    env.gain.setValueAtTime(0.0001, start)
    env.gain.exponentialRampToValueAtTime(gain, start + 0.006)
    env.gain.exponentialRampToValueAtTime(0.0001, end)
    osc.connect(env).connect(master)
    osc.start(start)
    osc.stop(end + 0.02)
  }

  private noise(ms: number, gain: number, filter: BiquadFilterType, from: number, to: number, delayMs = 0): void {
    const { ctx, master } = this
    if (!ctx || !master) return
    const samples = Math.ceil((ctx.sampleRate * ms) / 1000)
    const buffer = ctx.createBuffer(1, samples, ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) data[i] = Math.random() * 2 - 1
    const start = ctx.currentTime + delayMs / 1000
    const end = start + ms / 1000
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const shape = ctx.createBiquadFilter()
    shape.type = filter
    shape.frequency.setValueAtTime(from, start)
    shape.frequency.exponentialRampToValueAtTime(to, end)
    const env = ctx.createGain()
    env.gain.setValueAtTime(gain, start)
    env.gain.exponentialRampToValueAtTime(0.0001, end)
    source.connect(shape).connect(env).connect(master)
    source.start(start)
  }

  play(name: SoundName): void {
    if (this.muted || this.ctx?.state !== "running") return
    switch (name) {
      case "leak":
        this.tone(1320, 990, 70, 0.05, "triangle")
        this.tone(1395, 1040, 70, 0.03, "sine", 18)
        break
      case "press":
        this.tone(120, 42, 420, 0.55)
        this.noise(40, 0.25, "highpass", 2000, 4000)
        break
      case "wave":
        this.noise(700, 0.18, "bandpass", 180, 2400)
        this.tone(70, 40, 600, 0.3)
        break
      case "snap":
        this.tone(190, 55, 130, 0.38, "square")
        this.noise(90, 0.3, "highpass", 3000, 7000)
        this.tone(68, 36, 300, 0.45, "sine", 10)
        break
      case "refused":
        this.tone(95, 60, 110, 0.16, "triangle")
        break
      case "receipt":
        this.tone(880, 880, 320, 0.07)
        this.tone(1760, 1760, 220, 0.03)
        break
      case "clear":
        ;[440, 660, 880].forEach((f, i) => this.tone(f, f, 620 - i * 60, 0.09, "sine", i * 110))
        break
      case "asks":
        this.tone(620, 620, 110, 0.07, "triangle")
        this.tone(620, 620, 110, 0.07, "triangle", 170)
        break
      case "erase":
        this.tone(760, 48, 1000, 0.12, "sawtooth")
        this.noise(800, 0.2, "highpass", 5000, 1500)
        for (let i = 0; i < 12; i++) this.tone(2400 + Math.random() * 3600, 1800 + Math.random() * 2400, 90, 0.035, "sine", i * 36)
        break
    }
  }

  /** A low hum while a STOP is on its way. */
  startHum(): void {
    const { ctx, master } = this
    if (!ctx || !master || this.hum) return
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, ctx.currentTime)
    gain.gain.exponentialRampToValueAtTime(0.09, ctx.currentTime + 0.5)
    const low = ctx.createBiquadFilter()
    low.type = "lowpass"
    low.frequency.value = 340
    low.connect(gain).connect(master)
    const sources = [55, 55.7, 82.6].map((f) => {
      const osc = ctx.createOscillator()
      osc.type = "sawtooth"
      osc.frequency.value = f
      osc.connect(low)
      osc.start()
      return osc
    })
    this.hum = { gain, sources }
  }

  stopHum(): void {
    const { ctx, hum } = this
    if (!ctx || !hum) return
    this.hum = undefined
    hum.gain.gain.cancelScheduledValues(ctx.currentTime)
    hum.gain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.08)
    for (const s of hum.sources) s.stop(ctx.currentTime + 0.5)
  }
}
