import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';

export const COLLECTION_RANK_PREFIX = 'collectionRank:';

export const SAMPLE_COLLECTION_RANK = 3;

export function collectionRankField(collectionId: string): string {
  return `${COLLECTION_RANK_PREFIX}${collectionId}`;
}

export function extractRankCollectionIds(
  templateDataArray: OverlayTemplateData[]
): Set<string> {
  const ids = new Set<string>();
  for (const templateData of templateDataArray) {
    for (const element of templateData.elements) {
      if (element.type !== 'variable') continue;
      const props = element.properties as {
        segments?: { type: string; field?: string }[];
      };
      for (const segment of props.segments ?? []) {
        if (
          segment.type === 'variable' &&
          segment.field?.startsWith(COLLECTION_RANK_PREFIX)
        ) {
          const id = segment.field.slice(COLLECTION_RANK_PREFIX.length);
          if (id) ids.add(id);
        }
      }
    }
  }
  return ids;
}

/** 1-based position of every item in an ordered list of rating keys. */
export function rankByRatingKey(orderedKeys: string[]): Map<string, number> {
  const ranks = new Map<string, number>();
  orderedKeys.forEach((key, index) => {
    if (!ranks.has(key)) ranks.set(key, index + 1);
  });
  return ranks;
}

export function buildItemRankContext(
  ratingKey: string,
  ranksByCollection: ReadonlyMap<string, ReadonlyMap<string, number>>
): Record<string, number> {
  const context: Record<string, number> = {};
  for (const [collectionId, ranks] of ranksByCollection) {
    const rank = ranks.get(ratingKey);
    if (rank !== undefined) context[collectionRankField(collectionId)] = rank;
  }
  return context;
}

export function sampleCollectionRankContext(
  templateDataArray: OverlayTemplateData[]
): Record<string, number> {
  const context: Record<string, number> = {};
  for (const id of extractRankCollectionIds(templateDataArray)) {
    context[collectionRankField(id)] = SAMPLE_COLLECTION_RANK;
  }
  return context;
}
