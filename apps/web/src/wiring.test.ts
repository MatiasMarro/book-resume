import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS } from '@lector/shared';

// Smoke test del cableado del workspace: que la PWA resuelva el paquete
// compartido en runtime, no solo en tipos.
describe('workspace', () => {
  it('resuelve @lector/shared desde apps/web', () => {
    expect(APPEAL_DIMENSIONS).toHaveLength(14);
  });
});
