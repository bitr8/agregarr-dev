import type { PlexLibraryItem } from '@server/api/plexapi';
import type {
  ApplicationCondition,
  OverlayTemplateData,
} from '@server/entity/OverlayTemplate';
import {
  calculateOverlayInputHash,
  extractUsedContextFields,
} from '@server/utils/metadataHashing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({}),
}));

import { evaluateCondition } from './conditionEvaluator';
import { buildRenderContext } from './OverlayContextBuilder';

const version = (resolution: string, file: string) => ({
  videoResolution: resolution,
  Part: [{ file }],
});

const item = (media: unknown[], type = 'movie') =>
  ({
    ratingKey: '9001',
    title: 'Sample Film',
    type,
    guid: 'plex://movie/sample',
    Guid: [],
    addedAt: 0,
    updatedAt: 0,
    Media: media,
  } as unknown as PlexLibraryItem);

const build = async (i: PlexLibraryItem) =>
  (
    await buildRenderContext(
      i,
      'movie',
      false,
      undefined,
      undefined,
      new Set(['versionCount'])
    )
  ).context;

describe('versionCount in buildRenderContext', () => {
  it('counts every Media entry and flags more than one', async () => {
    const ctx = await build(
      item([version('1080', '/m/a.mkv'), version('1080', '/m/b.mkv')])
    );
    expect(ctx.versionCount).toBe(2);
    expect(ctx.hasMultipleVersions).toBe(true);
  });

  it('is 1 and not multiple for a single version', async () => {
    const ctx = await build(item([version('1080', '/m/a.mkv')]));
    expect(ctx.versionCount).toBe(1);
    expect(ctx.hasMultipleVersions).toBe(false);
  });

  it('leaves both unset when there is no Media (seasons)', async () => {
    const ctx = await build(item([], 'season'));
    expect(ctx.versionCount).toBeUndefined();
    expect(ctx.hasMultipleVersions).toBeUndefined();
  });

  it('still reads resolution from the first version only', async () => {
    const ctx = await build(
      item([version('720', '/m/a.mkv'), version('4k', '/m/b.mkv')])
    );
    expect(ctx.resolution).toBe('720');
  });
});

describe('version conditions', () => {
  const base = { isPlaceholder: false, mediaType: 'movie' as const };
  const gt1: ApplicationCondition = {
    sections: [
      { rules: [{ field: 'versionCount', operator: 'gt', value: 1 }] },
    ],
  };
  const flag: ApplicationCondition = {
    sections: [
      {
        rules: [{ field: 'hasMultipleVersions', operator: 'eq', value: true }],
      },
    ],
  };
  const neq1: ApplicationCondition = {
    sections: [
      { rules: [{ field: 'versionCount', operator: 'neq', value: 1 }] },
    ],
  };

  it('greater than 1 matches 2 only', () => {
    expect(evaluateCondition(gt1, { ...base, versionCount: 2 })).toBe(true);
    expect(evaluateCondition(gt1, { ...base, versionCount: 1 })).toBe(false);
    expect(evaluateCondition(gt1, base)).toBe(false);
  });

  it('the yes/no field does not match a missing value', () => {
    expect(
      evaluateCondition(flag, { ...base, hasMultipleVersions: true })
    ).toBe(true);
    expect(evaluateCondition(flag, base)).toBe(false);
  });

  it('not equal to 1 also matches a missing count', () => {
    expect(evaluateCondition(neq1, base)).toBe(true);
  });
});

describe('version fields and the overlay input hash', () => {
  const templateData = [
    {
      width: 1000,
      height: 1500,
      elements: [
        {
          id: 'e1',
          layerOrder: 0,
          type: 'variable',
          x: 0,
          y: 0,
          width: 100,
          height: 40,
          properties: { segments: [{ type: 'variable', field: 'title' }] },
        },
      ],
    },
  ] as unknown as OverlayTemplateData[];
  const condition: ApplicationCondition = {
    sections: [
      { rules: [{ field: 'versionCount', operator: 'gt', value: 1 }] },
    ],
  };

  const hash = (withCondition: boolean, versionCount: number) =>
    calculateOverlayInputHash({
      templateIds: [1],
      templateData,
      usedFields: extractUsedContextFields(
        templateData,
        withCondition ? [condition] : undefined
      ),
      context: { title: 'Sample Film', mediaType: 'movie', versionCount },
    });

  it('changes when a template condition reads versionCount', () => {
    expect(hash(true, 1)).not.toBe(hash(true, 2));
  });

  it('does not change for templates that never read it', () => {
    expect(hash(false, 1)).toBe(hash(false, 2));
  });
});
