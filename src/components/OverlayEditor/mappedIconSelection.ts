export const overlayMappingsKey = (field: string) =>
  `/api/v1/overlay-mappings/${field}`;

export interface IconMapping {
  value: string;
  iconPath: string;
}

export interface MappedIconSelection {
  mappings: IconMapping[];
  unmatchedValue?: string;
}

export function selectMappedIcons(
  mappings: IconMapping[],
  fieldValue: unknown,
  maxIcons: number | undefined,
  isSingleField: boolean,
  fallback: IconMapping[] = []
): MappedIconSelection {
  const pool = mappings.length > 0 ? mappings : fallback;
  const find = (list: IconMapping[], value: string) =>
    list.find((m) => m.value.toLowerCase() === value.toLowerCase());

  if (fieldValue !== undefined && fieldValue !== null) {
    const values: string[] = Array.isArray(fieldValue)
      ? fieldValue.map(String)
      : [String(fieldValue)];

    const matched: IconMapping[] = [];
    for (const value of values) {
      const mapping = find(mappings, value) ?? find(fallback, value);
      if (mapping) {
        matched.push(mapping);
      }
    }

    if (matched.length === 0 && pool.length > 0 && values.length > 0) {
      // Editor preview only: server rendering still renders nothing on no match
      return { mappings: pool.slice(0, 1), unmatchedValue: values[0] };
    }

    const limit = maxIcons && maxIcons > 0 ? maxIcons : matched.length;
    return { mappings: matched.slice(0, limit) };
  }

  if (pool.length > 0) {
    const previewLimit = isSingleField
      ? 1
      : maxIcons && maxIcons > 0
      ? maxIcons
      : pool.length;
    return { mappings: pool.slice(0, previewLimit) };
  }

  return { mappings: [] };
}
