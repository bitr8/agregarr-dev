import type { PlexLibraryItem } from '@server/api/plexapi';
import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';
import {
  calculateOverlayInputHash,
  extractUsedContextFields,
} from '@server/utils/metadataHashing';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@server/lib/settings', () => ({
  getSettings: () => ({}),
}));

import { resolveEdition } from './editionContext';
import { buildRenderContext } from './OverlayContextBuilder';

const movie = (over: Partial<PlexLibraryItem> & { file?: string }) =>
  ({
    ratingKey: '1',
    title: 'Test Film',
    type: 'movie',
    guid: 'plex://movie/abc',
    Guid: [],
    addedAt: 0,
    updatedAt: 0,
    Media: over.file
      ? [{ Part: [{ file: over.file }] }]
      : (over.Media as PlexLibraryItem['Media']),
    editionTitle: over.editionTitle,
  } as unknown as PlexLibraryItem);

describe('resolveEdition', () => {
  it('uses Plex editionTitle when present', () => {
    expect(
      resolveEdition(
        movie({
          editionTitle: 'IMAX',
          file: '/m/Film (2020) {edition-Extended Cut}.mkv',
        })
      )
    ).toBe('IMAX');
  });

  it('falls back to the {edition-...} filename tag', () => {
    expect(
      resolveEdition(
        movie({ file: '/m/Film (2020)/Film (2020) {edition-Extended Cut}.mkv' })
      )
    ).toBe('Extended Cut');
  });

  it('ignores an edition tag in a parent folder', () => {
    expect(
      resolveEdition(movie({ file: '/m/{edition-Fake}/Film (2020).mkv' }))
    ).toBeUndefined();
  });

  it('is empty when neither source has an edition', () => {
    expect(
      resolveEdition(movie({ file: '/m/Film (2020).mkv' }))
    ).toBeUndefined();
    expect(resolveEdition(movie({}))).toBeUndefined();
  });
});

describe('buildRenderContext edition', () => {
  const fields = new Set(['edition']);

  it('exposes editionTitle on the context', async () => {
    const { context } = await buildRenderContext(
      movie({ editionTitle: 'Unrated' }),
      'movie',
      false,
      undefined,
      undefined,
      fields
    );
    expect(context.edition).toBe('Unrated');
  });

  it('exposes the filename tag when editionTitle is missing', async () => {
    const { context } = await buildRenderContext(
      movie({ file: '/m/Film {edition-Director Cut}.mkv' }),
      'movie',
      false,
      undefined,
      undefined,
      fields
    );
    expect(context.edition).toBe('Director Cut');
  });

  it('leaves edition unset otherwise', async () => {
    const { context } = await buildRenderContext(
      movie({ file: '/m/Film.mkv' }),
      'movie',
      false,
      undefined,
      undefined,
      fields
    );
    expect(context.edition).toBeUndefined();
  });
});

describe('edition and the overlay input hash', () => {
  const template = (field: string): OverlayTemplateData[] =>
    [
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
            properties: {
              segments: [{ type: 'variable', field }],
            },
          },
        ],
      },
    ] as unknown as OverlayTemplateData[];

  const hash = (field: string, edition?: string) => {
    const templateData = template(field);
    return calculateOverlayInputHash({
      templateIds: [1],
      templateData,
      usedFields: extractUsedContextFields(templateData),
      context: { title: 'Test Film', mediaType: 'movie', edition },
    });
  };

  it('does not change when the template does not reference edition', () => {
    expect(hash('title', undefined)).toBe(hash('title', 'Extended Cut'));
  });

  it('changes when a template references edition', () => {
    expect(hash('edition', undefined)).not.toBe(
      hash('edition', 'Extended Cut')
    );
  });
});

describe('buildRenderContext edition on placeholders', () => {
  it('does not expose the placeholder trailer tag as an edition', async () => {
    const { context } = await buildRenderContext(
      movie({ editionTitle: 'Trailer', file: '/m/Film {edition-Trailer}.mp4' }),
      'movie',
      true,
      undefined,
      undefined,
      new Set(['edition'])
    );
    expect(context.edition).toBeUndefined();
  });
});
