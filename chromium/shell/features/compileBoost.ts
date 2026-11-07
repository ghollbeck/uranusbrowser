/**
 * A script boost's TypeScript, compiled to a script that runs once, as esbuild's iife did in
 * Electron. Runs on the Boosts page, so the compiler stays out of the background.
 */
import { transform } from 'sucrase';
import type { CompiledBoost } from './boosts';

export function compileBoost(name: string, source: string): CompiledBoost {
  try {
    const { code } = transform(source, { transforms: ['typescript', 'imports'], filePath: name, production: true });
    // `imports` turns `export {}` and friends into CommonJS; give it somewhere to write.
    return { code: `(() => {\nconst exports = {}, module = { exports };\n${code}\n})();\n//# sourceURL=anus-boost/${name}` };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
