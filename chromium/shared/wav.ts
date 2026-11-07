/**
 * 16 kHz mono 16-bit PCM WAV, the one audio format meeting notes use between the capture page
 * (which encodes it), the shell and the native host (which checks it before it goes to a
 * transcription engine). Pure: no Node, no chrome.*.
 *
 * The header layout follows OpenWhisper's `wavHeader` in src/main/meetings/audioArchive.ts
 * (the user's own app, MIT licensed).
 */

export const WAV_RATE = 16000;
export const WAV_HEADER_BYTES = 44;

/** The 44-byte header of a mono 16-bit PCM WAV holding `pcmBytes` bytes of samples. */
export function wavHeader(pcmBytes: number, rate = WAV_RATE): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, pcmBytes + 36, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, pcmBytes, true);
  return bytes;
}

/** A complete WAV file for these samples. */
export function encodeWav(samples: Int16Array, rate = WAV_RATE): Uint8Array {
  const out = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  out.set(wavHeader(samples.length * 2, rate), 0);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) view.setInt16(WAV_HEADER_BYTES + i * 2, samples[i], true);
  return out;
}

/** Float samples in -1..1 to 16-bit, clipped. */
export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/** Root-mean-square level of 16-bit samples, 0 to 1. */
export function rmsLevel(samples: Int16Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length) / 0x8000;
}

export interface WavInfo {
  /** Bytes of PCM data. */
  pcmBytes: number;
  durationMs: number;
}

/**
 * Checks that these bytes are exactly what the capture page makes (RIFF/WAVE, PCM, mono,
 * 16-bit, 16 kHz, a data chunk that fits) and says how long it is; throws a short, content-free
 * reason otherwise. Other chunks (LIST, say) before `data` are skipped.
 */
export function inspectWav(bytes: Uint8Array): WavInfo {
  if (bytes.length < WAV_HEADER_BYTES) throw new Error('The audio is too short to be a WAV file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('The audio is not a WAV file.');
  let fmtOk = false;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const size = view.getUint32(offset + 4, true);
    const name = tag(offset);
    if (name === 'fmt ') {
      if (size < 16 || offset + 8 + 16 > bytes.length) throw new Error('The WAV header is damaged.');
      fmtOk =
        view.getUint16(offset + 8, true) === 1 &&
        view.getUint16(offset + 10, true) === 1 &&
        view.getUint32(offset + 12, true) === WAV_RATE &&
        view.getUint16(offset + 22, true) === 16;
      if (!fmtOk) throw new Error('The audio must be 16 kHz mono 16-bit PCM.');
    } else if (name === 'data') {
      if (!fmtOk) throw new Error('The WAV header is damaged.');
      if (offset + 8 + size > bytes.length) throw new Error('The WAV data is cut off.');
      if (size % 2) throw new Error('The WAV data is not whole 16-bit samples.');
      return { pcmBytes: size, durationMs: Math.round((size / 2 / WAV_RATE) * 1000) };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('The WAV file has no audio data.');
}

/** Standard base64 of bytes (browser and Node safe, in slices so large arrays don't overflow the stack). */
export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Resamples mono float audio from one rate to another by linear interpolation, with a short
 * box average first when downsampling (speech, not music: good enough for recognition).
 */
export function resampleMono(input: Float32Array, from: number, to = WAV_RATE): Float32Array {
  if (from === to || !input.length) return input;
  const ratio = from / to;
  const length = Math.floor(input.length / ratio);
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    if (ratio > 1) {
      const start = Math.floor(position);
      const end = Math.min(input.length, Math.max(start + 1, Math.floor(position + ratio)));
      let sum = 0;
      for (let j = start; j < end; j++) sum += input[j];
      out[i] = sum / (end - start);
    } else {
      const index = Math.floor(position);
      const frac = position - index;
      const next = input[Math.min(index + 1, input.length - 1)];
      out[i] = input[index] * (1 - frac) + next * frac;
    }
  }
  return out;
}
