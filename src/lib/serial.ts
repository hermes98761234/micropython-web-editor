import type { Transport } from './protocol'

interface SerialPortLike {
  open(o: { baudRate: number }): Promise<void>
  close(): Promise<void>
  readable: ReadableStream<Uint8Array> | null
  writable: WritableStream<Uint8Array> | null
  getInfo?(): { usbVendorId?: number; usbProductId?: number }
}
interface SerialLike {
  requestPort(o?: { filters?: { usbVendorId?: number }[] }): Promise<SerialPortLike>
}

export const serialSupported = (): boolean => typeof navigator !== 'undefined' && 'serial' in navigator

export class SerialTransport implements Transport {
  onData: ((d: Uint8Array) => void) | null = null
  private port: SerialPortLike
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  private closing = false
  /** Called when the device is unplugged or the read loop dies. */
  onClose: (() => void) | null = null
  constructor(port: SerialPortLike) {
    this.port = port
  }

  static async request(baudRate: number): Promise<SerialTransport> {
    const serial = (navigator as unknown as { serial: SerialLike }).serial
    const port = await serial.requestPort()
    await port.open({ baudRate })
    const t = new SerialTransport(port)
    t.startReading()
    return t
  }

  private startReading(): void {
    this.reader = this.port.readable!.getReader()
    this.writer = this.port.writable!.getWriter()
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await this.reader!.read()
          if (done) break
          if (value) this.onData?.(value)
        }
      } catch {
        /* device removed */
      } finally {
        if (!this.closing) this.onClose?.()
      }
    })()
  }

  async write(data: Uint8Array): Promise<void> {
    await this.writer?.write(data)
  }

  async close(): Promise<void> {
    this.closing = true
    try { await this.reader?.cancel() } catch { /* ignore */ }
    try { this.reader?.releaseLock() } catch { /* ignore */ }
    try { this.writer?.releaseLock() } catch { /* ignore */ }
    try { await this.port.close() } catch { /* ignore */ }
  }
}
