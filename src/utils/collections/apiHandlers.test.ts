import type { CollectionFormConfig } from '@app/types/collections';
import { buildSelectionFieldsPayload } from '@app/utils/collections/apiHandlers';
import { describe, expect, it } from 'vitest';

describe('buildSelectionFieldsPayload', () => {
  it('round-trips selectionMode/excludeValues/includeValues for essentials configs', () => {
    const config = {
      selectionMode: 'exclude',
      excludeValues: ['gb/16'],
      includeValues: [],
    } as Pick<
      CollectionFormConfig,
      'selectionMode' | 'excludeValues' | 'includeValues'
    >;

    const payload = buildSelectionFieldsPayload(config);

    expect(payload.selectionMode).toBe('exclude');
    expect(payload.excludeValues).toEqual(['gb/16']);
    expect(payload.includeValues).toEqual([]);
  });

  it('omits fields left undefined rather than sending null/undefined', () => {
    const payload = buildSelectionFieldsPayload({});

    expect('selectionMode' in payload).toBe(false);
    expect('excludeValues' in payload).toBe(false);
    expect('includeValues' in payload).toBe(false);
  });
});
