import { apiErrorMessage } from '@app/utils/apiErrorMessage';
import { describe, expect, it } from 'vitest';

describe('apiErrorMessage', () => {
  it('returns the server message from an axios-shaped error', () => {
    const error = {
      isAxiosError: true,
      response: { data: { message: 'Radarr tag ID not specified' } },
    };

    expect(apiErrorMessage(error, 'fallback')).toBe(
      'Radarr tag ID not specified'
    );
  });

  it('falls back to the given message for a plain Error', () => {
    expect(apiErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });

  it('falls back to error when only error is present in the response', () => {
    const error = {
      isAxiosError: true,
      response: { data: { error: 'Something broke' } },
    };

    expect(apiErrorMessage(error, 'fallback')).toBe('Something broke');
  });
});
