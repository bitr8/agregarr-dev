import type { ApplicationCondition } from '@server/entity/OverlayTemplate';

/**
 * Evaluate an application condition against the render context
 * Returns true if condition is met (or if no condition specified)
 *
 * Uses flat section/rule structure:
 * - Evaluate each section by combining its rules with their ruleOperators
 * - Combine sections using their sectionOperators
 */
export function evaluateCondition(
  condition: ApplicationCondition | undefined,
  context: object
): boolean {
  if (!condition || !condition.sections || condition.sections.length === 0) {
    return true; // No condition = always apply
  }

  // Evaluate first section
  let result = evaluateSection(condition.sections[0], context);

  // Combine remaining sections using their sectionOperators
  for (let i = 1; i < condition.sections.length; i++) {
    const section = condition.sections[i];
    const sectionResult = evaluateSection(section, context);

    if (section.sectionOperator === 'and') {
      result = result && sectionResult;
    } else {
      // Default to OR if not specified
      result = result || sectionResult;
    }
  }

  return result;
}

/**
 * Evaluate a single section by combining its rules
 */
function evaluateSection(
  section: {
    rules: {
      ruleOperator?: 'and' | 'or';
      field: string;
      operator: string;
      value: unknown;
    }[];
  },
  context: object
): boolean {
  if (!section.rules || section.rules.length === 0) {
    return true; // Empty section = always true
  }

  // Evaluate first rule
  let result = evaluateRule(section.rules[0], context);

  // Combine remaining rules using their ruleOperators
  for (let i = 1; i < section.rules.length; i++) {
    const rule = section.rules[i];
    const ruleResult = evaluateRule(rule, context);

    if (rule.ruleOperator === 'or') {
      result = result || ruleResult;
    } else {
      // Default to AND if not specified
      result = result && ruleResult;
    }
  }

  return result;
}

/**
 * Evaluate condition and return detailed results for debugging
 * Returns the same boolean result as evaluateCondition, plus detailed evaluation info
 */
export function evaluateConditionDetailed(
  condition: ApplicationCondition | undefined,
  context: object
): {
  matched: boolean;
  sectionResults: {
    sectionIndex: number;
    sectionOperator?: 'and' | 'or';
    matched: boolean;
    ruleResults: {
      ruleIndex: number;
      ruleOperator?: 'and' | 'or';
      field: string;
      operator: string;
      value: unknown;
      actualValue: unknown;
      matched: boolean;
    }[];
  }[];
} {
  if (!condition || !condition.sections || condition.sections.length === 0) {
    return {
      matched: true,
      sectionResults: [],
    };
  }

  const sectionResults = condition.sections.map((section, sectionIndex) => {
    const ruleResults = section.rules.map((rule, ruleIndex) => {
      const actualValue = (context as Record<string, unknown>)[rule.field];
      const matched = evaluateRule(rule, context);

      return {
        ruleIndex,
        ruleOperator: rule.ruleOperator,
        field: rule.field,
        operator: rule.operator,
        value: rule.value,
        actualValue,
        matched,
      };
    });

    // Determine section match based on rule operator logic
    let sectionMatched = ruleResults[0]?.matched ?? true;
    for (let i = 1; i < ruleResults.length; i++) {
      const ruleResult = ruleResults[i];
      if (ruleResult.ruleOperator === 'or') {
        sectionMatched = sectionMatched || ruleResult.matched;
      } else {
        // Default to AND
        sectionMatched = sectionMatched && ruleResult.matched;
      }
    }

    return {
      sectionIndex,
      sectionOperator: section.sectionOperator,
      matched: sectionMatched,
      ruleResults,
    };
  });

  // Determine overall match based on section operator logic
  let overallMatched = sectionResults[0]?.matched ?? true;
  for (let i = 1; i < sectionResults.length; i++) {
    const sectionResult = sectionResults[i];
    if (sectionResult.sectionOperator === 'and') {
      overallMatched = overallMatched && sectionResult.matched;
    } else {
      // Default to OR
      overallMatched = overallMatched || sectionResult.matched;
    }
  }

  return {
    matched: overallMatched,
    sectionResults,
  };
}

const anyString = (value: unknown, test: (item: string) => boolean): boolean =>
  Array.isArray(value)
    ? value.some((item) => typeof item === 'string' && test(item))
    : typeof value === 'string' && test(value);

/**
 * Evaluate a single rule (field/operator/value comparison)
 */
function evaluateRule(
  rule: { field: string; operator: string; value: unknown },
  context: object
): boolean {
  const value = (context as Record<string, unknown>)[rule.field];
  const conditionValue = rule.value;

  // Handle undefined/null values specially based on operator
  if (value === undefined || value === null) {
    // For 'neq' (not equal), missing/null IS different from any defined value
    // e.g., "downloaded != true" should match when downloaded is undefined
    if (rule.operator === 'neq') {
      return conditionValue !== undefined && conditionValue !== null;
    }
    // For 'notContains', missing/null doesn't contain anything, so return true
    // e.g., "filePath does not contain '2005'" should match when filePath is undefined
    if (rule.operator === 'notContains') {
      return true;
    }
    // For 'exists', we need to evaluate based on the presence/absence of value
    if (rule.operator === 'exists') {
      // value is null/undefined, so field does NOT exist
      // Return true if conditionValue is false (checking for non-existence)
      return conditionValue === false;
    }
    // For all other operators (eq, gt, gte, lt, lte, contains, in, etc.)
    // undefined/null means the condition can't be evaluated, so false
    return false;
  }

  switch (rule.operator) {
    case 'eq':
      // For array fields (like radarrTags/sonarrTags), check if array contains the value
      if (Array.isArray(value) && typeof conditionValue === 'string') {
        return value.some(
          (item) =>
            typeof item === 'string' &&
            item.toLowerCase() === conditionValue.toLowerCase()
        );
      }
      // Case-insensitive comparison for strings
      if (typeof value === 'string' && typeof conditionValue === 'string') {
        return value.toLowerCase() === conditionValue.toLowerCase();
      }
      return value === conditionValue;
    case 'neq':
      // For array fields, check if array does NOT contain the value
      if (Array.isArray(value) && typeof conditionValue === 'string') {
        return !value.some(
          (item) =>
            typeof item === 'string' &&
            item.toLowerCase() === conditionValue.toLowerCase()
        );
      }
      // Case-insensitive comparison for strings
      if (typeof value === 'string' && typeof conditionValue === 'string') {
        return value.toLowerCase() !== conditionValue.toLowerCase();
      }
      return value !== conditionValue;
    case 'gt':
      return (
        typeof value === 'number' &&
        typeof conditionValue === 'number' &&
        value > conditionValue
      );
    case 'gte':
      return (
        typeof value === 'number' &&
        typeof conditionValue === 'number' &&
        value >= conditionValue
      );
    case 'lt':
      return (
        typeof value === 'number' &&
        typeof conditionValue === 'number' &&
        value < conditionValue
      );
    case 'lte':
      return (
        typeof value === 'number' &&
        typeof conditionValue === 'number' &&
        value <= conditionValue
      );
    case 'in':
      // The condition editor saves `in` values as comma-separated text
      if (
        typeof conditionValue === 'string' ||
        typeof conditionValue === 'number'
      ) {
        const wanted = String(conditionValue)
          .split(',')
          .map((item) => item.trim().toLowerCase())
          .filter((item) => item !== '');
        return (Array.isArray(value) ? value : [value]).some(
          (item) =>
            (typeof item === 'string' || typeof item === 'number') &&
            wanted.includes(String(item).toLowerCase())
        );
      }
      // Case-insensitive comparison for string arrays
      if (typeof value === 'string' && Array.isArray(conditionValue)) {
        return conditionValue.some(
          (item) =>
            typeof item === 'string' &&
            item.toLowerCase() === value.toLowerCase()
        );
      }
      return (
        Array.isArray(conditionValue) &&
        conditionValue.includes(value as string | number)
      );
    case 'contains':
      // For array fields, check if array contains the value
      if (Array.isArray(value) && typeof conditionValue === 'string') {
        return value.some(
          (item) =>
            typeof item === 'string' &&
            item.toLowerCase().includes(conditionValue.toLowerCase())
        );
      }
      return (
        typeof value === 'string' &&
        typeof conditionValue === 'string' &&
        value.toLowerCase().includes(conditionValue.toLowerCase())
      );
    case 'notContains':
      // For array fields, check if array does NOT contain the value
      if (Array.isArray(value) && typeof conditionValue === 'string') {
        return !value.some(
          (item) =>
            typeof item === 'string' &&
            item.toLowerCase().includes(conditionValue.toLowerCase())
        );
      }
      return (
        typeof value === 'string' &&
        typeof conditionValue === 'string' &&
        !value.toLowerCase().includes(conditionValue.toLowerCase())
      );
    case 'regex':
      if (typeof conditionValue === 'string') {
        let regex: RegExp;
        try {
          regex = new RegExp(conditionValue, 'i');
        } catch {
          return false;
        }
        return anyString(value, (item) => regex.test(item));
      }
      return false;
    case 'begins':
      return (
        typeof conditionValue === 'string' &&
        anyString(value, (item) =>
          item.toLowerCase().startsWith(conditionValue.toLowerCase())
        )
      );
    case 'ends':
      return (
        typeof conditionValue === 'string' &&
        anyString(value, (item) =>
          item.toLowerCase().endsWith(conditionValue.toLowerCase())
        )
      );
    case 'exists':
      // Check if field has a non-null/undefined value
      // conditionValue should be boolean: true = exists, false = not exists
      if (typeof conditionValue === 'boolean') {
        const hasValue = value !== undefined && value !== null;
        return conditionValue ? hasValue : !hasValue;
      }
      return false;
    default:
      return false;
  }
}
