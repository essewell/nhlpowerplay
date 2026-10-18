// Lint for the pure engine. These bans enforce the CLAUDE.md determinism rule:
// all randomness and time come from inputs, never from globals.
import tseslint from "typescript-eslint";

export default tseslint.config(
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-properties": [
        "error",
        { object: "Math", property: "random", message: "Use the seeded PRNG passed in (modes.ts)." },
        { object: "Date", property: "now", message: "Engine must not read the clock; pass time in." },
      ],
      "no-restricted-globals": [
        "error",
        { name: "performance", message: "Engine must not read the clock; pass time in." },
        { name: "crypto", message: "Use the seeded PRNG passed in (modes.ts)." },
        { name: "globalThis", message: "No ambient globals in the engine." },
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: "Engine must not read the clock; pass time in." },
      ],
    },
  },
);
