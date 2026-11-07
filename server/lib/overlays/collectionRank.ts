import type { OverlayTemplateData } from '@server/entity/OverlayTemplate';

export const COLLECTION_RANK_PREFIX = 'collectionRank:';

export const SAMPLE_COLLECTION_RANK = 3;

export function collectionRankField(collectionId: string): string {
  return `${COLLECTION_RANK_PREFIX}${collectionId}`;
}

type RuleCondition =
  | { sections?: { rules?: { field?: string }[] }[] }
  | null
  | undefined;

const rankIdFromField = (field?: string): string | undefined => {
  if (!field?.startsWith(COLLECTION_RANK_PREFIX)) return undefined;
  return field.slice(COLLECTION_RANK_PREFIX.length) || undefined;
};

const conditionFields = (condition: RuleCondition): string[] =>
  (condition?.sections ?? []).flatMap((section) =>
    (section.rules ?? []).map((rule) => rule.field ?? '')
  );

export function extractRankCollectionIds(
  templateDataArray: OverlayTemplateData[],
  applicationConditions: RuleCondition[] = []
): Set<string> {
  const fields: string[] = [];
  for (const templateData of templateDataArray) {
    for (const element of templateData.elements) {
      if (element.type === 'variable') {
        const props = element.properties as {
          segments?: { type: string; field?: string }[];
        };
        for (const segment of props.segments ?? []) {
          if (segment.type === 'variable' && segment.field) {
            fields.push(segment.field);
          }
        }
      }
      fields.push(...conditionFields(element.condition as RuleCondition));
    }
  }
  for (const condition of applicationConditions) {
    fields.push(...conditionFields(condition));
  }

  const ids = new Set<string>();
  for (const field of fields) {
    const id = rankIdFromField(field);
    if (id) ids.add(id);
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

export function rankContextFromOrderedKeys(
  collectionId: string,
  ratingKey: string,
  orderedKeys: string[]
): Record<string, number> {
  return buildItemRankContext(
    ratingKey,
    new Map([[collectionId, rankByRatingKey(orderedKeys)]])
  );
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

export interface RankCollectionConfig {
  id: string;
  collectionRatingKey?: string;
  collectionRatingKeys?: string[];
}

/**
 * Per-collection replacement of cached ranks. A fetch that threw keeps the
 * previous ranks; a successful empty fetch clears them.
 */
export async function refreshRankCache(
  cache: Map<string, Map<string, number>>,
  ids: Iterable<string>,
  configs: RankCollectionConfig[],
  fetchOrderedKeys: (collectionRatingKey: string) => Promise<string[]>,
  onFetchError: (collectionId: string, error: unknown) => void
): Promise<void> {
  for (const id of ids) {
    const config = configs.find((c) => c.id === id);
    const ratingKey = config?.collectionRatingKeys?.length
      ? undefined
      : config?.collectionRatingKey;
    if (!ratingKey) {
      cache.delete(id);
      continue;
    }
    try {
      cache.set(id, rankByRatingKey(await fetchOrderedKeys(ratingKey)));
    } catch (error) {
      onFetchError(id, error);
    }
  }
}
