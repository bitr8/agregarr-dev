import { arrayMove } from '@dnd-kit/sortable';
import type { ConditionRule } from '@server/entity/OverlayTemplate';

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

const TEXT_ONLY_OPERATORS = [
  'contains',
  'notContains',
  'regex',
  'begins',
  'ends',
];

export function isOperatorOfferedForField(
  operator: string,
  kind: FieldKind
): boolean {
  return (
    !isOperatorInvalidForField(operator, kind) &&
    !(kind.isNumeric && TEXT_ONLY_OPERATORS.includes(operator))
  );
}

export function coerceValueForOperator(
  previousOperator: string,
  newOperator: string,
  value: unknown,
  kind: Pick<FieldKind, 'isNumeric' | 'isBoolean'>
): unknown {
  if (newOperator === 'exists') return true;
  if (previousOperator === 'exists' && !kind.isBoolean) return '';
  if (kind.isNumeric && !kind.isBoolean) {
    if (newOperator === 'in') {
      return typeof value === 'number' ? String(value) : value;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const n = Number(value);
      return Number.isNaN(n) ? '' : n;
    }
    return typeof value === 'number' ? value : '';
  }
  return value;
}

export function reorderRules(
  rules: ConditionRule[],
  oldIndex: number,
  newIndex: number
): ConditionRule[] {
  return arrayMove(rules, oldIndex, newIndex).map((rule, i) => {
    const next = { ...rule };
    delete next.ruleOperator;
    const slot = rules[i].ruleOperator;
    return slot ? { ...next, ruleOperator: slot } : next;
  });
}
