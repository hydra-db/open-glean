import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // React Compiler rules that eslint-config-next promotes to `error` in
    // Next 16. Both fire on patterns that are correct and unavoidable here:
    //
    //  - set-state-in-effect flags the SSR-safe mount pattern
    //    (useEffect(() => setMounted(true), []) and reading localStorage after
    //    mount). Removing the effect reintroduces hydration mismatches.
    //  - refs flags reading a ref during render in the graph component, which
    //    is intentional for measuring the canvas.
    //
    // Keep them as warnings so the signal stays visible without failing the
    // lint gate on correct code.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
