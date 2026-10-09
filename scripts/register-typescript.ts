import { registerHooks } from "node:module";

// Source modules use their emitted .js import names. Resolve only missing relative
// .js modules to .ts, leaving Node's native, offset-preserving type stripping in
// charge of loading. Dependencies and built artifacts retain normal resolution.
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (!specifier.startsWith(".") || !specifier.endsWith(".js") ||
          !(error instanceof Error) || !("code" in error) || error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      try {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      } catch {
        throw error;
      }
    }
  },
});
