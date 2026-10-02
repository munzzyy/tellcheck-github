// Load with --import so the worker imports test/detector-stub.mjs when the private detector is absent.
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";

const REAL = new URL("../worker/src/detector-core.js", import.meta.url);
const STUB = new URL("./detector-stub.mjs", import.meta.url);

if (!existsSync(REAL)) {
  registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL && new URL(specifier, context.parentURL).href === REAL.href) {
        return { url: STUB.href, shortCircuit: true };
      }
      return next(specifier, context);
    },
  });
}
