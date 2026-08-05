import { describe, expect, it } from 'vitest';
import { APPEAL_DIMENSIONS } from '@lector/shared';

// Smoke test del cableado del workspace: que el Worker pueda resolver el paquete
// compartido en runtime, no solo en tipos. Si esto se rompe, se rompe la fase 2.
describe('workspace', () => {
  it('resuelve @lector/shared desde apps/api', () => {
    expect(APPEAL_DIMENSIONS).toHaveLength(14);
  });
});
