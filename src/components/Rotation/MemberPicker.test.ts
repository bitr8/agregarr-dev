import MemberPicker from '@app/components/Rotation/MemberPicker';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-intl', () => ({
  defineMessages: (m: unknown) => m,
  useIntl: () => ({ formatMessage: (m: string) => m }),
}));

const render = (locked: boolean, candidates: unknown[]) =>
  renderToStaticMarkup(
    createElement(MemberPicker, {
      candidates: candidates as never,
      loading: false,
      onRetry: () => undefined,
      libraryId: 'lib-1',
      libraryName: 'Movies',
      selected: new Set<string>(),
      onSelectedChange: () => undefined,
      saved: new Map(),
      onShowNext: () => undefined,
      actionsLocked: locked,
      lockTip: 'A sync is running.',
      onLookInPlex: () => undefined,
      excluded: new Set<string>(),
      looking: false,
      lookResult: null,
    })
  );

const row = {
  key: 'preExisting:a',
  kind: 'preExisting',
  configId: 'a',
  name: 'Alpha',
  libraryId: 'lib-1',
  libraryName: 'Movies',
  type: 'preExisting',
  selectable: true,
};

describe('MemberPicker look in Plex', () => {
  it('shows when the library already has collections', () => {
    expect(render(false, [row])).toContain('Look for collections in Plex');
  });

  it('is disabled with a reason while a sync runs', () => {
    const html = render(true, [row]);
    expect(html).toContain('A sync is running.');
    expect(html).toMatch(
      /<button[^>]*disabled[^>]*><span[^>]*>Look for collections/
    );
  });
});
