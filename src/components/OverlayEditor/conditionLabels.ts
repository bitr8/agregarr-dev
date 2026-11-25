import { CONDITION_FIELD_CATEGORIES } from './types';

// Operator display labels
export const OPERATOR_LABELS: Record<string, string> = {
  eq: '=',
  neq: '≠',
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  in: 'in',
  contains: 'contains',
  notContains: '!contains',
  regex: 'regex',
  begins: 'begins',
  ends: 'ends',
};

// Get field label from CONDITION_FIELD_CATEGORIES
export const getFieldLabel = (field: string): string => {
  const allFields = Object.values(CONDITION_FIELD_CATEGORIES).flat();
  return allFields.find((v) => v.field === field)?.label || field;
};
