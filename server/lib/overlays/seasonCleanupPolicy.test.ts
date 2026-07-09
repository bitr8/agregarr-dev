import type { PlexMetadata } from '@server/api/plexapi';
import { describe, expect, it } from 'vitest';

import { classifySeasonCleanupAction } from './seasonCleanupPolicy';

/**
 * The real BCS season used throughout the Maintainerr season-overlay work:
 * ratingKey 25417, "Season 1", librarySectionID 3.
 */
const season = (overrides: Partial<PlexMetadata> = {}): PlexMetadata =>
  ({
    ratingKey: '25417',
    type: 'season',
    title: 'Season 1',
    index: 1,
    librarySectionID: 3,
    ...overrides,
  } as PlexMetadata);

describe('classifySeasonCleanupAction', () => {
  it('untracks a season Plex confirms is gone', () => {
    expect(classifySeasonCleanupAction({ status: 'not_found' }, '3')).toEqual({
      action: 'untrack',
    });
  });

  it('attempts the restore when the existence check is ambiguous', () => {
    // Never skip and never delete on ambiguity: try to recover. A failed upload
    // throws, so recovery data survives.
    expect(classifySeasonCleanupAction({ status: 'error' }, '3')).toEqual({
      action: 'restore',
      title: 'Season',
    });
  });

  it('restores a season positively identified in its own library', () => {
    expect(
      classifySeasonCleanupAction({ status: 'ok', meta: season() }, '3')
    ).toEqual({ action: 'restore', title: 'Season 1' });
  });

  it('refuses to restore when the rating key now resolves to a show', () => {
    expect(
      classifySeasonCleanupAction(
        { status: 'ok', meta: season({ type: 'show', title: 'Breaking Bad' }) },
        '3'
      )
    ).toEqual({
      action: 'mismatch',
      foundType: 'show',
      foundLibrarySectionID: '3',
    });
  });

  it('refuses to restore a season that now lives in a different library', () => {
    expect(
      classifySeasonCleanupAction(
        { status: 'ok', meta: season({ librarySectionID: 5 }) },
        '3'
      )
    ).toEqual({
      action: 'mismatch',
      foundType: 'season',
      foundLibrarySectionID: '5',
    });
  });

  it('treats a missing librarySectionID as doubt, not agreement', () => {
    // Fails CLOSED. The subpass excludes such an item from the active set, so
    // cleanup must not accept it as a match either.
    expect(
      classifySeasonCleanupAction(
        { status: 'ok', meta: season({ librarySectionID: undefined }) },
        '3'
      )
    ).toEqual({
      action: 'mismatch',
      foundType: 'season',
      foundLibrarySectionID: null,
    });
  });

  it('compares librarySectionID numerically-to-string, not by identity', () => {
    // Plex sends a number; the row holds a string. A regression here silently
    // mismatches every season and strands the whole library.
    expect(
      classifySeasonCleanupAction(
        { status: 'ok', meta: season({ librarySectionID: 3 }) },
        '3'
      ).action
    ).toBe('restore');
  });
});
