import { describe, expect, it } from 'vitest';
import Settings from './settings';

describe('Posterizarr settings', () => {
  it('disables callback processing by default', () => {
    const settings = new Settings();

    expect(settings.overlays?.posterizarrIntegrationEnabled).toBe(false);
  });
});
