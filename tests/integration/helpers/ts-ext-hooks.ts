// Resolve hook for bare-`node` child processes that import src/ modules:
// src uses `.js` import specifiers (NodeNext, rewritten by tsc and remapped
// by vitest), but node's type-stripping does NOT remap them, so a transitive
// VALUE import of src from a child entry dies with ERR_MODULE_NOT_FOUND.
// This hook retries failed relative `.js` resolutions as `.ts`.
//
// Child entries must import this module FIRST and load everything else via
// dynamic import() — static imports resolve before any hook registers.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if ((specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js')) {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
      throw error;
    }
  },
});
