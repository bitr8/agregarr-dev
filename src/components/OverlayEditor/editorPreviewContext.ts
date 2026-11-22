import { SAMPLE_PREVIEW_CONTEXTS } from '@app/components/OverlayEditor/types';
import type { ApplicationCondition } from '@server/entity/OverlayTemplate';
import { evaluateCondition } from '@server/lib/overlays/conditionEvaluator';
import type { OverlayRenderContext } from '@server/lib/overlays/overlayRenderContext';
import { createSampleOverlayContext } from '@server/lib/overlays/sampleOverlayContext';

export function buildEditorPreviewContext(
  mediaType: 'movie' | 'tv' | undefined,
  metadata: OverlayRenderContext | undefined
): OverlayRenderContext {
  if (!metadata) {
    return (
      mediaType === 'tv'
        ? SAMPLE_PREVIEW_CONTEXTS.tv
        : SAMPLE_PREVIEW_CONTEXTS.movie
    ) as OverlayRenderContext;
  }
  const context = createSampleOverlayContext(
    mediaType === 'tv' ? 'show' : 'movie'
  ) as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined) context[key] = value;
  }
  return context as unknown as OverlayRenderContext;
}

export function elementMatchesContext(
  condition: ApplicationCondition | undefined,
  context: object | undefined
): boolean {
  return !condition || !context || evaluateCondition(condition, context);
}
