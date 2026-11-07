/**
 * The audio tap for meeting notes: runs on the audio thread, copies the first channel it hears
 * into blocks of 4096 samples and posts them to the capture page, which cuts them into chunks
 * (lib/meetingsChunker.ts). It produces no sound, and it keeps nothing.
 */
declare const registerProcessor: (name: string, processor: unknown) => void;
const Base = (globalThis as unknown as { AudioWorkletProcessor: new () => { port: MessagePort } }).AudioWorkletProcessor;

const BLOCK = 4096;

class MeetingTap extends Base {
  private buffer = new Float32Array(BLOCK);
  private filled = 0;

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    let at = 0;
    while (at < channel.length) {
      const take = Math.min(channel.length - at, BLOCK - this.filled);
      this.buffer.set(channel.subarray(at, at + take), this.filled);
      this.filled += take;
      at += take;
      if (this.filled === BLOCK) {
        this.port.postMessage(this.buffer, [this.buffer.buffer]);
        this.buffer = new Float32Array(BLOCK);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('anus-meeting-tap', MeetingTap);
export {};
