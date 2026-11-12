import type {
  ApplicationCondition,
  ConditionRule,
  OverlayElement,
  OverlayTextElementProps,
  OverlayTileElementProps,
  OverlayVariableElementProps,
} from './types';

export type LayoutWarningKind =
  | 'out-of-bounds'
  | 'text-clipped'
  | 'text-outside-badge'
  | 'text-overlap';

export interface LayoutWarning {
  kind: LayoutWarningKind;
  elementId: string;
  otherElementId?: string;
  otherLabel?: string;
}

export interface LayoutWarningLayer {
  label: string;
  condition?: ApplicationCondition;
  elements: OverlayElement[];
}

export type MeasureText = (
  text: string,
  fontSize: number,
  fontFamily: string,
  fontWeight: string
) => number;

export interface LayoutWarningInput {
  width: number;
  height: number;
  elements: OverlayElement[];
  condition?: ApplicationCondition;
  others?: LayoutWarningLayer[];
  measureText?: MeasureText;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const EPSILON = 0.5;
const VARIABLE_PLACEHOLDER = '00000';

const estimateTextWidth: MeasureText = (text, fontSize, _family, weight) =>
  text.length * fontSize * (weight === 'bold' ? 0.62 : 0.57);

const getElementText = (element: OverlayElement): string | null => {
  if (element.type === 'text') {
    return (element.properties as OverlayTextElementProps).text || '';
  }
  if (element.type === 'variable') {
    const { segments } = element.properties as OverlayVariableElementProps;
    return segments
      .map((s) =>
        s.type === 'text' ? s.value || '' : s.field ? VARIABLE_PLACEHOLDER : ''
      )
      .join('');
  }
  return null;
};

const rotatedBounds = (element: OverlayElement): Rect => {
  const rotation = ((element.rotation || 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  const width = element.width * cos + element.height * sin;
  const height = element.width * sin + element.height * cos;
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  return { x: cx - width / 2, y: cy - height / 2, width, height };
};

const intersects = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width - EPSILON &&
  b.x < a.x + a.width - EPSILON &&
  a.y < b.y + b.height - EPSILON &&
  b.y < a.y + a.height - EPSILON;

const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x - EPSILON &&
  inner.y >= outer.y - EPSILON &&
  inner.x + inner.width <= outer.x + outer.width + EPSILON &&
  inner.y + inner.height <= outer.y + outer.height + EPSILON;

interface TextLayout {
  textWidth: number;
  fontSize: number;
  clipped: boolean;
}

const layoutText = (
  element: OverlayElement,
  text: string,
  measure: MeasureText
): TextLayout => {
  const props = element.properties as
    | OverlayTextElementProps
    | OverlayVariableElementProps;
  const textWidth = measure(
    text,
    props.fontSize,
    props.fontFamily,
    props.fontWeight
  );
  return {
    textWidth,
    fontSize: props.fontSize,
    clipped:
      textWidth > element.width + EPSILON ||
      props.fontSize > element.height + EPSILON,
  };
};

const rotateRect = (
  rect: Rect,
  rotationDeg: number,
  element: OverlayElement
) => {
  if (!rotationDeg) return rect;
  const r = (rotationDeg * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const ecx = element.x + element.width / 2;
  const ecy = element.y + element.height / 2;
  const dx = rect.x + rect.width / 2 - ecx;
  const dy = rect.y + rect.height / 2 - ecy;
  const cx = ecx + dx * cos - dy * sin;
  const cy = ecy + dx * sin + dy * cos;
  const width = rect.width * Math.abs(cos) + rect.height * Math.abs(sin);
  const height = rect.width * Math.abs(sin) + rect.height * Math.abs(cos);
  return { x: cx - width / 2, y: cy - height / 2, width, height };
};

const textExtent = (element: OverlayElement, layout: TextLayout): Rect => {
  const align = (
    element.properties as OverlayTextElementProps | OverlayVariableElementProps
  ).textAlign;
  const width = Math.min(layout.textWidth, element.width);
  const height = Math.min(layout.fontSize, element.height);
  let x = element.x + (element.width - width) / 2;
  if (align === 'left') x = element.x;
  else if (align === 'right') x = element.x + element.width - width;
  return rotateRect(
    { x, y: element.y + (element.height - height) / 2, width, height },
    element.rotation || 0,
    element
  );
};

const looseEqual = (a: unknown, b: unknown): boolean =>
  String(a).toLowerCase() === String(b).toLowerCase();

const asList = (rule: ConditionRule): unknown[] => {
  if (Array.isArray(rule.value)) return rule.value;
  if (rule.operator === 'in' && typeof rule.value === 'string') {
    return rule.value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [rule.value];
};

interface NumericRange {
  lo: number;
  hi: number;
  loOpen: boolean;
  hiOpen: boolean;
}

const toRange = (rule: ConditionRule): NumericRange | null => {
  const n = typeof rule.value === 'number' ? rule.value : NaN;
  if (Number.isNaN(n)) return null;
  const inf = Number.POSITIVE_INFINITY;
  switch (rule.operator) {
    case 'eq':
      return { lo: n, hi: n, loOpen: false, hiOpen: false };
    case 'gt':
      return { lo: n, hi: inf, loOpen: true, hiOpen: false };
    case 'gte':
      return { lo: n, hi: inf, loOpen: false, hiOpen: false };
    case 'lt':
      return { lo: -inf, hi: n, loOpen: false, hiOpen: true };
    case 'lte':
      return { lo: -inf, hi: n, loOpen: false, hiOpen: false };
    default:
      return null;
  }
};

const rangesDisjoint = (a: NumericRange, b: NumericRange): boolean => {
  if (a.hi < b.lo || b.hi < a.lo) return true;
  if (a.hi === b.lo) return a.hiOpen || b.loOpen;
  if (b.hi === a.lo) return b.hiOpen || a.loOpen;
  return false;
};

const SCALAR_STRING_FIELDS = new Set([
  'resolution',
  'videoCodec',
  'videoProfile',
  'audioCodec',
  'audioProfile',
  'audioChannelLayout',
  'audioLanguage',
  'audioLanguageCode',
  'container',
  'tmdbStatus',
  'tvdbStatus',
  'streamingProvider',
  'showResolution',
  'showVideoCodec',
  'showAudioCodec',
]);

const ARRAY_FIELDS = new Set([
  'radarrTags',
  'sonarrTags',
  'audioLanguages',
  'audioLanguageCodes',
  'subtitleLanguages',
  'subtitleLanguageCodes',
  'collection',
  'plexLabels',
]);

const rulesContradict = (a: ConditionRule, b: ConditionRule): boolean => {
  if (a.field !== b.field) return false;
  const ra = toRange(a);
  const rb = toRange(b);
  if (ra && rb) return !ARRAY_FIELDS.has(a.field) && rangesDisjoint(ra, rb);

  const isEqLike = (r: ConditionRule) =>
    r.operator === 'eq' || r.operator === 'in';
  if (isEqLike(a) && isEqLike(b)) {
    if (!SCALAR_STRING_FIELDS.has(a.field)) return false;
    const bValues = asList(b);
    return !asList(a).some((va) => bValues.some((vb) => looseEqual(va, vb)));
  }
  const eqVsNeq = (eq: ConditionRule, neq: ConditionRule) =>
    isEqLike(eq) &&
    neq.operator === 'neq' &&
    asList(eq).every((v) => looseEqual(v, neq.value));
  return eqVsNeq(a, b) || eqVsNeq(b, a);
};

const conjunctionRules = (
  condition: ApplicationCondition | undefined
): ConditionRule[] | null => {
  if (!condition || condition.sections.length === 0) return null;
  const rules: ConditionRule[] = [];
  for (let si = 0; si < condition.sections.length; si++) {
    const section = condition.sections[si];
    if (si > 0 && section.sectionOperator !== 'and') return null;
    for (let ri = 0; ri < section.rules.length; ri++) {
      const rule = section.rules[ri];
      if (ri > 0 && rule.ruleOperator === 'or') return null;
      rules.push(rule);
    }
  }
  return rules;
};

export const conditionsMutuallyExclusive = (
  a: ApplicationCondition | undefined,
  b: ApplicationCondition | undefined
): boolean => {
  const ra = conjunctionRules(a);
  const rb = conjunctionRules(b);
  if (!ra || !rb) return false;
  return ra.some((x) => rb.some((y) => rulesContradict(x, y)));
};

interface TextItem {
  elementId: string;
  label?: string;
  condition?: ApplicationCondition;
  extent: Rect;
}

const findBadge = (
  element: OverlayElement,
  tiles: OverlayElement[]
): OverlayElement | undefined => {
  const cx = element.x + element.width / 2;
  const cy = element.y + element.height / 2;
  return tiles
    .filter(
      (t) =>
        !t.rotation &&
        t.layerOrder <= element.layerOrder &&
        cx >= t.x &&
        cx <= t.x + t.width &&
        cy >= t.y &&
        cy <= t.y + t.height &&
        !conditionsMutuallyExclusive(t.condition, element.condition)
    )
    .sort((x, y) => y.layerOrder - x.layerOrder)[0];
};

export function computeLayoutWarnings(
  input: LayoutWarningInput
): LayoutWarning[] {
  const measure = input.measureText ?? estimateTextWidth;
  const canvas: Rect = { x: 0, y: 0, width: input.width, height: input.height };
  const warnings: LayoutWarning[] = [];
  const ownItems: TextItem[] = [];

  const tiles = input.elements.filter((e) => {
    if (e.type !== 'tile') return false;
    const p = e.properties as OverlayTileElementProps;
    return p.fillOpacity > 0;
  });

  for (const element of input.elements) {
    if (!contains(canvas, rotatedBounds(element))) {
      warnings.push({ kind: 'out-of-bounds', elementId: element.id });
    }

    const text = getElementText(element);
    if (text === null || text.trim() === '') continue;

    const layout = layoutText(element, text, measure);
    if (layout.clipped) {
      warnings.push({ kind: 'text-clipped', elementId: element.id });
    }

    const extent = textExtent(element, layout);
    ownItems.push({
      elementId: element.id,
      condition: element.condition,
      extent,
    });

    if (!element.rotation) {
      const badge = findBadge(element, tiles);
      if (badge && !contains(badge, extent)) {
        warnings.push({ kind: 'text-outside-badge', elementId: element.id });
      }
    }
  }

  const compare = (
    a: TextItem,
    b: TextItem,
    aLayer?: ApplicationCondition,
    bLayer?: ApplicationCondition
  ) => {
    if (!intersects(a.extent, b.extent)) return;
    const aConds = [a.condition, aLayer];
    const bConds = [b.condition, bLayer];
    if (
      aConds.some((x) => bConds.some((y) => conditionsMutuallyExclusive(x, y)))
    ) {
      return;
    }
    warnings.push({
      kind: 'text-overlap',
      elementId: a.elementId,
      otherElementId: b.elementId,
      otherLabel: b.label,
    });
  };

  for (let i = 0; i < ownItems.length; i++) {
    for (let j = i + 1; j < ownItems.length; j++) {
      const a = ownItems[i];
      const b = ownItems[j];
      compare(a, b);
    }
  }

  for (const layer of input.others ?? []) {
    for (const element of layer.elements) {
      const text = getElementText(element);
      if (text === null || text.trim() === '') continue;
      const other: TextItem = {
        elementId: element.id,
        label: layer.label,
        condition: element.condition,
        extent: textExtent(element, layoutText(element, text, measure)),
      };
      for (const own of ownItems) {
        compare(own, other, input.condition, layer.condition);
      }
    }
  }

  return warnings;
}
