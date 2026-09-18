import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('sanitizeErrorMessage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('NODE_ENV', 'production');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('keeps the real express-openapi-validator rejection wording in production', async () => {
    const { sanitizeErrorMessage } = await import(
      '@server/utils/errorResponse'
    );

    expect(
      sanitizeErrorMessage(
        new Error("request.body should have required property 'id'")
      )
    ).toBe("request.body should have required property 'id'");
  });

  it('keeps the slash form of a validator message in production', async () => {
    const { sanitizeErrorMessage } = await import(
      '@server/utils/errorResponse'
    );

    expect(
      sanitizeErrorMessage(new Error('request/body must be integer'))
    ).toBe('request/body must be integer');
  });

  it('still degrades a request/ message that also matches a sensitive pattern', async () => {
    const { sanitizeErrorMessage } = await import(
      '@server/utils/errorResponse'
    );

    expect(
      sanitizeErrorMessage(new Error('request/body/plexToken must be string'))
    ).toBe('An unexpected error occurred');
  });
});
