import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// Config propia para los tests: sin el plugin de PWA ni el de Tailwind, que no
// aportan nada en jsdom y solo agregan trabajo por corrida.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // `lib/` es matemática pura y CLAUDE.md la exige 100% cubierta. Medir los
    // componentes de React con la misma vara no dice nada útil, así que la
    // cobertura mira solo acá.
    coverage: {
      provider: 'v8',
      include: ['src/lib/**'],
      reporter: ['text', 'html'],
    },
  },
});
