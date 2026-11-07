import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';
import {
  calculateOverlayInputHash,
  extractUsedContextFields,
} from '@server/utils/metadataHashing';
import { describe, expect, it } from 'vitest';
import {
  buildItemRankContext,
  collectionRankField,
  extractRankCollectionIds,
  rankByRatingKey,
  rankContextFromOrderedKeys,
  sampleCollectionRankContext,
} from './collectionRank';

const template = (field: string): OverlayTemplateData =>
  ({
    width: 500,
    height: 750,
    elements: [
      {
        id: 'e1',
        type: 'variable',
        properties: {
          segments: [{ type: 'variable', field }],
        },
      },
    ],
  } as unknown as OverlayTemplateData);

describe('collection rank', () => {
  it('ranks items by 1-based position', () => {
    const ranks = rankByRatingKey(['a', 'b', 'c']);
    expect(ranks.get('a')).toBe(1);
    expect(ranks.get('c')).toBe(3);
    expect(ranks.get('z')).toBeUndefined();
  });

  it('extracts only rank fields that name a collection', () => {
    const ids = extractRankCollectionIds([
      template('collectionRank:col-1'),
      template('collectionRank:'),
      template('imdbRating'),
    ]);
    expect([...ids]).toEqual(['col-1']);
  });

  it('also finds rank fields used by conditions', () => {
    const withCondition = {
      ...template('imdbRating'),
      elements: [
        {
          ...template('imdbRating').elements[0],
          condition: {
            sections: [{ rules: [{ field: 'collectionRank:el-1' }] }],
          },
        },
      ],
    } as unknown as OverlayTemplateData;
    const ids = extractRankCollectionIds(
      [withCondition],
      [{ sections: [{ rules: [{ field: 'collectionRank:app-1' }] }] }]
    );
    expect([...ids].sort()).toEqual(['app-1', 'el-1']);
  });

  it('builds a context key only for collections containing the item', () => {
    const ranksByCollection = new Map([
      ['col-1', rankByRatingKey(['a', 'b'])],
      ['col-2', rankByRatingKey(['b'])],
    ]);
    expect(buildItemRankContext('b', ranksByCollection)).toEqual({
      [collectionRankField('col-1')]: 2,
      [collectionRankField('col-2')]: 1,
    });
    expect(buildItemRankContext('q', ranksByCollection)).toEqual({});
  });

  it('gives previews a sample rank for each referenced collection', () => {
    expect(
      sampleCollectionRankContext([template('collectionRank:col-9')])
    ).toEqual({ 'collectionRank:col-9': 3 });
  });

  it('reaches the overlay hash only when a template uses the rank', () => {
    const used = extractUsedContextFields([template('collectionRank:col-1')]);
    const hashFor = (
      rank: number,
      fields: Set<string>,
      data = [template('collectionRank:col-1')]
    ) =>
      calculateOverlayInputHash({
        templateIds: [1],
        templateData: data,
        usedFields: fields,
        context: { 'collectionRank:col-1': rank, mediaType: 'movie' },
      });

    expect(used.has('collectionRank:col-1')).toBe(true);
    expect(hashFor(1, used)).not.toBe(hashFor(2, used));

    const plain = [template('imdbRating')];
    const usedPlain = extractUsedContextFields(plain);
    expect(usedPlain.has('collectionRank:col-1')).toBe(false);
    expect(hashFor(1, usedPlain, plain)).toBe(hashFor(2, usedPlain, plain));
  });

  it('builds the test-item rank context from collection order', () => {
    expect(rankContextFromOrderedKeys('c1', 'b', ['a', 'b'])).toEqual({
      'collectionRank:c1': 2,
    });
    expect(rankContextFromOrderedKeys('c1', 'z', ['a', 'b'])).toEqual({});
  });
});
