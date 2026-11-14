export interface FieldKind {
  isNumeric: boolean;
  isBoolean: boolean;
  isCollection: boolean;
  isPlexLabels: boolean;
}

const NUMERIC_ONLY_OPERATORS = ['gt', 'gte', 'lt', 'lte'];

export function isOperatorInvalidForField(
  operator: string,
  kind: FieldKind
): boolean {
  return (
    (!kind.isNumeric && NUMERIC_ONLY_OPERATORS.includes(operator)) ||
    (kind.isBoolean && !['eq', 'neq'].includes(operator)) ||
    (kind.isCollection && !['eq', 'neq'].includes(operator)) ||
    (kind.isPlexLabels && !['eq', 'neq'].includes(operator))
  );
}
