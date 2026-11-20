import {
  buildEditorPreviewContext,
  elementMatchesContext,
} from '@app/components/OverlayEditor/editorPreviewContext';
import { SAMPLE_PREVIEW_CONTEXTS } from '@app/components/OverlayEditor/types';
import { evaluateCondition } from '@server/lib/overlays/conditionEvaluator';
import { describe, expect, it } from 'vitest';

describe('buildEditorPreviewContext', () => {
  it('lets the preview response win, so variables and conditions read one value', () => {
    const context = buildEditorPreviewContext('tv', {
      title: 'Severance',
      resolution: '1080p',
      studio: undefined,
    } as never);
    expect(context.resolution).toBe('1080p');
    expect(context.title).toBe('Severance');
    expect(context.studio).toBe('Warner Bros.');
    expect(context.mediaType).toBe('show');
    expect(
      evaluateCondition(
        {
          sections: [
            { rules: [{ field: 'resolution', operator: 'eq', value: '4K' }] },
          ],
        } as never,
        context
      )
    ).toBe(false);
  });

  it('falls back to the bundled sample when there is no response', () => {
    expect(buildEditorPreviewContext('movie', undefined)).toBe(
      SAMPLE_PREVIEW_CONTEXTS.movie
    );
    expect(buildEditorPreviewContext(undefined, undefined)).toBe(
      SAMPLE_PREVIEW_CONTEXTS.movie
    );
    expect(buildEditorPreviewContext('tv', undefined)).toBe(
      SAMPLE_PREVIEW_CONTEXTS.tv
    );
  });
});

describe('elementMatchesContext', () => {
  const only4k = {
    sections: [
      { rules: [{ field: 'resolution', operator: 'eq', value: '4K' }] },
    ],
  } as never;

  it('hides an element whose condition fails and keeps unconditional ones', () => {
    expect(elementMatchesContext(only4k, { resolution: '1080p' })).toBe(false);
    expect(elementMatchesContext(only4k, { resolution: '4K' })).toBe(true);
    expect(elementMatchesContext(undefined, { resolution: '1080p' })).toBe(
      true
    );
  });
});
