// @vitest-environment jsdom
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  config: {
    libraryId: '2',
    libraryName: 'Shows',
    mediaType: 'show',
    enabledOverlays: [{ templateId: 1, enabled: true, layerOrder: 0 }],
    fullSyncTargets: undefined as string[] | undefined,
    quickSyncTargets: undefined as string[] | undefined,
  },
  templates: [
    { id: 1, name: 'Main overlay', type: 'custom', tags: ['target:main'] },
  ],
  fetch: vi.fn(),
}));

vi.mock('swr', () => ({
  default: (url: string) => ({
    data:
      url === '/api/v1/overlay-templates'
        ? { templates: mocks.templates }
        : url?.startsWith('/api/v1/overlay-library-configs/')
        ? mocks.config
        : {},
  }),
  mutate: vi.fn(),
}));
vi.mock('react-intl', () => ({
  defineMessages: (messages: unknown) => messages,
  useIntl: () => ({
    formatMessage: (message: string, values: Record<string, string> = {}) =>
      message.replace(/\{(\w+)\}/g, (_, key) => values[key] ?? key),
  }),
}));
vi.mock('@app/components/Common/Modal', () => ({
  default: ({
    children,
    onOk,
  }: {
    children: React.ReactNode;
    onOk: () => void;
  }) =>
    React.createElement(
      'div',
      null,
      children,
      React.createElement('button', { onClick: onOk }, 'Save Configuration')
    ),
}));
vi.mock('@app/components/OverlayEditor/types', () => ({
  AVAILABLE_VARIABLES: {},
}));

import LibraryDetailConfigView from './LibraryDetailConfigView';

describe('library overlay scope controls', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', mocks.fetch.mockResolvedValue({ ok: true }));
    mocks.config.fullSyncTargets = undefined;
    mocks.config.quickSyncTargets = undefined;
    mocks.templates = [
      { id: 1, name: 'Main overlay', type: 'custom', tags: ['target:main'] },
    ];
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const render = async (libraryType: 'movie' | 'show' = 'show') => {
    await act(async () =>
      root.render(
        React.createElement(LibraryDetailConfigView, {
          isOpen: true,
          onClose: vi.fn(),
          libraryId: '2',
          libraryName: 'Library',
          libraryType,
        })
      )
    );
  };
  const row = (label: string) =>
    Array.from(container.querySelectorAll('span')).find(
      (span) => span.textContent === label
    )?.parentElement;
  const checkboxes = (label: string) =>
    Array.from(
      row(label)?.querySelectorAll<HTMLInputElement>('input[type=checkbox]') ??
        []
    );
  const save = async () => {
    const button = Array.from(container.querySelectorAll('button')).find(
      (item) => item.textContent === 'Save Configuration'
    );
    if (!button) throw new Error('Save Configuration button is missing');
    await act(async () => button.click());
    const request = mocks.fetch.mock.calls.find(
      ([url]) => url === '/api/v1/overlay-library-configs/2'
    );
    if (!request) throw new Error('Library configuration was not saved');
    return JSON.parse(request[1].body);
  };

  it('shows all TV target rows but defaults both jobs to main only', async () => {
    await render();
    expect(checkboxes('Show posters').map((input) => input.checked)).toEqual([
      true,
      true,
    ]);
    expect(checkboxes('Season posters').map((input) => input.checked)).toEqual([
      false,
      false,
    ]);
    expect(checkboxes('Episode cards').map((input) => input.checked)).toEqual([
      false,
      false,
    ]);
    expect(container.textContent).not.toContain('Full sync will skip');
  });

  it('shows only movie posters for a movie library', async () => {
    await render('movie');
    expect(checkboxes('Movie posters')).toHaveLength(2);
    expect(row('Season posters')).toBeUndefined();
    expect(row('Episode cards')).toBeUndefined();
  });

  it('lets users opt in, warns about missing full-sync templates, and saves the choices', async () => {
    await render();
    await act(async () => checkboxes('Episode cards')[0].click());
    expect(container.textContent).toContain(
      'Full sync will skip Episode cards'
    );
    await act(async () => checkboxes('Season posters')[1].click());
    const saved = await save();
    expect(saved.fullSyncTargets).toEqual(['main', 'episode']);
    expect(saved.quickSyncTargets).toEqual(['main', 'season']);
  });

  it('lets users untick previously saved child targets', async () => {
    mocks.config.fullSyncTargets = ['main', 'season', 'episode'];
    mocks.config.quickSyncTargets = ['episode'];
    await render();
    await act(async () => {
      checkboxes('Season posters')[0].click();
      checkboxes('Episode cards')[0].click();
      checkboxes('Episode cards')[1].click();
    });
    const saved = await save();
    expect(saved.fullSyncTargets).toEqual(['main']);
    expect(saved.quickSyncTargets).toEqual([]);
    expect(container.textContent).not.toContain('Full sync will skip');
  });

  it('does not warn when an enabled template covers the selected child target', async () => {
    mocks.templates[0].tags = ['target:episode'];
    mocks.config.fullSyncTargets = ['episode'];
    await render();
    expect(checkboxes('Episode cards')[0].checked).toBe(true);
    expect(container.textContent).not.toContain('Full sync will skip');
  });
});
