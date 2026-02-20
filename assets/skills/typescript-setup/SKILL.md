---
name: typescript-setup
description: How to set up a new TypeScript project using the newest and best practices.
---

## Initial Setup (all projects)

 1. `npm init -y` (or user's package manager), then change (or set) `"type": "commonjs"` to `"type": "module"` in package.json; this must happen before any `tsc` invocation
 2. `npm install --save-dev typescript@latest`
 3. `npx tsc --init` to generate tsconfig.json
 4. Edit tsconfig.json:
    * Set `"rootDir": "./src"`
    * Remove the `"jsx"` lines unless the project uses JSX/React
 5. Create `src/` and add TypeScript files there

## Node Projects (server-side, CLI, scripts)

 * `npm install --save-dev @types/node`
 * In tsconfig.json, set `"module": "nodenext"`, uncomment and set `"types": ["node"]`
 * **No-transpile mode** (if node >= 22.6.0; check `node -v`):
   * Set `"noEmit": true`, `"erasableSyntaxOnly": true`, `"allowImportingTsExtensions": true`
   * Use `.ts` extensions in all relative imports (e.g., `import { foo } from "./foo.ts"`)
   * Run directly: `node src/index.ts`
   * Do not set `outDir` — it has no effect with `noEmit`
 * **Transpile mode** (for libraries or node < 22.6.0):
   * Set `"outDir": "./dist"` and add `"build": "tsc"` to package.json scripts
   * For libraries, also enable `"declaration": true`
   * Build with `npm run build`, run with `node dist/index.js`

## Bundler Projects (Vite, esbuild, webpack, Next.js, etc.)

 * Set `"moduleResolution": "bundler"` and `"module": "esnext"` in tsconfig.json
 * Set `"noEmit": true`; the bundler handles transpilation, tsc is only for type-checking
 * Keep `"jsx": "react-jsx"` if using React; set `"jsx": "preserve"` for frameworks that handle JSX themselves (Astro, Vite+Preact, etc.)
 * If you have more specific tsconfig guidance from the framework, defer to it
