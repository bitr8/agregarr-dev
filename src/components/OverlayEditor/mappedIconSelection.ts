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
  isSingleField: boolean
): MappedIconSelection {
  if (fieldValue !== undefined && fieldValue !== null) {
    const values: string[] = Array.isArray(fieldValue)
      ? fieldValue.map(String)
      : [String(fieldValue)];

    const matched: IconMapping[] = [];
    for (const value of values) {
      const mapping = mappings.find(
        (m) => m.value.toLowerCase() === value.toLowerCase()
      );
      if (mapping) {
        matched.push(mapping);
      }
    }

    if (matched.length === 0 && mappings.length > 0 && values.length > 0) {
      // Editor preview only: server rendering still renders nothing on no match
      return { mappings: mappings.slice(0, 1), unmatchedValue: values[0] };
    }

    const limit = maxIcons && maxIcons > 0 ? maxIcons : matched.length;
    return { mappings: matched.slice(0, limit) };
  }

  if (mappings.length > 0) {
    const previewLimit = isSingleField
      ? 1
      : maxIcons && maxIcons > 0
      ? maxIcons
      : mappings.length;
    return { mappings: mappings.slice(0, previewLimit) };
  }

  return { mappings: [] };
}
