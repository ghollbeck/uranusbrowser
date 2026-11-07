/**
 * Cuts a stream of audio blocks (at the audio context's rate) into ~10-second chunks of 16 kHz
 * mono 16-bit PCM, each with its start and end on the recording clock and its RMS level.
 * Pure, so the capture page's timing and resampling can be tested without a browser audio
 * stack. Audio is held only until a chunk is full; `onChunk` takes ownership of it.
 */
import { CHUNK_MS } from '../../shared/meetings';
import { WAV_RATE, floatToInt16, resampleMono, rmsLevel } from '../../shared/wav';

export interface Chunk {
  startMs: number;
  endMs: number;
  level: number;
  samples: Int16Array;
}

export class Chunker {
  private blocks: Float32Array[] = [];
  private held = 0;
  /** Samples (at `rate`) emitted or dropped before the blocks held now. */
  private before = 0;

  constructor(
    private rate: number,
    private onChunk: (chunk: Chunk) => void,
    private chunkMs = CHUNK_MS,
    /** Where this chunker's clock starts on the recording's, for a source that begins late. */
    private originMs = 0,
  ) {}

  private get perChunk() {
    return Math.round((this.rate * this.chunkMs) / 1000);
  }

  push(block: Float32Array) {
    this.blocks.push(block);
    this.held += block.length;
    while (this.held >= this.perChunk) this.emit(this.perChunk);
  }

  /** Emits what is held, if it is at least `minMs` long (a few words), and forgets the rest. */
  flush(minMs = 1000) {
    if (this.held >= (this.rate * minMs) / 1000) this.emit(this.held);
    else {
      this.before += this.held;
      this.blocks = [];
      this.held = 0;
    }
  }

  /** Milliseconds of audio seen so far. */
  get elapsedMs() {
    return this.originMs + Math.round(((this.before + this.held) / this.rate) * 1000);
  }

  private emit(count: number) {
    const joined = new Float32Array(count);
    let at = 0;
    const rest: Float32Array[] = [];
    for (const block of this.blocks) {
      if (at >= count) {
        rest.push(block);
        continue;
      }
      const take = Math.min(block.length, count - at);
      joined.set(block.subarray(0, take), at);
      at += take;
      if (take < block.length) rest.push(block.subarray(take));
    }
    this.blocks = rest;
    this.held -= count;
    const startMs = this.originMs + Math.round((this.before / this.rate) * 1000);
    this.before += count;
    const endMs = this.originMs + Math.round((this.before / this.rate) * 1000);
    const samples = floatToInt16(resampleMono(joined, this.rate, WAV_RATE));
    this.onChunk({ startMs, endMs, level: rmsLevel(samples), samples });
  }
}
