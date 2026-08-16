import { defineConfig } from 'tsup'

export default defineConfig({
  clean: true,
  dts: true,
  entry: ['src/index.ts'],
  external: ['pg'],
  format: ['esm', 'cjs'],
  sourcemap: true,
  target: 'node22',
})
