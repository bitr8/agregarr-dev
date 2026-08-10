import type { ApplicationCondition } from '@app/components/OverlayEditor/types';

export function evaluateCondition(
  condition: ApplicationCondition | undefined,
  context: Record<string, unknown>
): boolean {
  if (!condition?.sections?.length) return true;

  let result = evaluateSection(condition.sections[0], context);
  for (let i = 1; i < condition.sections.length; i++) {
    const section = condition.sections[i];
    const val = evaluateSection(section, context);
    result = section.sectionOperator === 'and' ? result && val : result || val;
  }
  return result;
}

function evaluateSection(
  section: ApplicationCondition['sections'][0],
  context: Record<string, unknown>
): boolean {
  if (!section.rules?.length) return true;

  let result = evaluateRule(section.rules[0], context);
  for (let i = 1; i < section.rules.length; i++) {
    const rule = section.rules[i];
    const val = evaluateRule(rule, context);
    result = rule.ruleOperator === 'or' ? result || val : result && val;
  }
  return result;
}

function evaluateRule(
  rule: { field: string; operator: string; value: unknown },
  context: Record<string, unknown>
): boolean {
  const value = context[rule.field];
  const cond = rule.value;

  if (value === undefined || value === null) {
    if (rule.operator === 'neq') return cond !== undefined && cond !== null;
    if (rule.operator === 'notContains') return true;
    return false;
  }

  const strVal = typeof value === 'string' ? value.toLowerCase() : '';
  const strCond = typeof cond === 'string' ? cond.toLowerCase() : '';

  switch (rule.operator) {
    case 'eq':
      if (typeof value === 'string' && typeof cond === 'string')
        return strVal === strCond;
      return value === cond;
    case 'neq':
      if (typeof value === 'string' && typeof cond === 'string')
        return strVal !== strCond;
      return value !== cond;
    case 'gt':
      return (
        typeof value === 'number' && typeof cond === 'number' && value > cond
      );
    case 'gte':
      return (
        typeof value === 'number' && typeof cond === 'number' && value >= cond
      );
    case 'lt':
      return (
        typeof value === 'number' && typeof cond === 'number' && value < cond
      );
    case 'lte':
      return (
        typeof value === 'number' && typeof cond === 'number' && value <= cond
      );
    case 'contains':
      return (
        typeof value === 'string' &&
        typeof cond === 'string' &&
        strVal.includes(strCond)
      );
    case 'notContains':
      return (
        typeof value === 'string' &&
        typeof cond === 'string' &&
        !strVal.includes(strCond)
      );
    default:
      return true;
  }
}
