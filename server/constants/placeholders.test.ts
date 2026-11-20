import {
  DEFAULT_PLACEHOLDER_DAYS_AHEAD,
  DEFAULT_PLACEHOLDER_RELEASED_DAYS,
  placeholdersEnabled,
  resolvePlaceholderDaysAhead,
  resolvePlaceholderReleasedDays,
} from '@server/constants/placeholders';
import {
  getDaysAhead,
  getReleasedDays,
  isPlaceholderCreationEnabled,
} from '@server/lib/placeholders/services/PlaceholderCreation';
import type { CollectionConfig } from '@server/lib/settings';
import { describe, expect, it } from 'vitest';

const cfg = (c: Record<string, unknown>) => c as unknown as CollectionConfig;

describe('placeholder window resolution', () => {
  it('keeps a stored 0 for released days', () => {
    expect(resolvePlaceholderReleasedDays({ placeholderReleasedDays: 0 })).toBe(
      0
    );
    expect(getReleasedDays(cfg({ placeholderReleasedDays: 0 }))).toBe(0);
  });

  it('does not fall through a stored 0 to the deprecated field', () => {
    expect(
      resolvePlaceholderReleasedDays({
        placeholderReleasedDays: 0,
        comingSoonReleasedDays: 30,
      })
    ).toBe(0);
  });

  it('uses the shared defaults when nothing is stored', () => {
    expect(resolvePlaceholderReleasedDays({})).toBe(14);
    expect(resolvePlaceholderDaysAhead({})).toBe(90);
    expect(getReleasedDays(cfg({}))).toBe(DEFAULT_PLACEHOLDER_RELEASED_DAYS);
    expect(getDaysAhead(cfg({}))).toBe(DEFAULT_PLACEHOLDER_DAYS_AHEAD);
  });

  it('falls back to the deprecated Coming Soon fields before the default', () => {
    expect(resolvePlaceholderDaysAhead({ comingSoonDays: 45 })).toBe(45);
    expect(resolvePlaceholderReleasedDays({ comingSoonReleasedDays: 3 })).toBe(
      3
    );
  });
});

describe('placeholdersEnabled', () => {
  it('is true for Coming Soon even when the stored flag is false or missing', () => {
    expect(
      placeholdersEnabled({
        type: 'comingsoon',
        createPlaceholdersForMissing: false,
      })
    ).toBe(true);
    expect(placeholdersEnabled({ type: 'comingsoon' })).toBe(true);
    expect(
      isPlaceholderCreationEnabled(
        cfg({ type: 'comingsoon', createPlaceholdersForMissing: false })
      )
    ).toBe(true);
  });

  it('follows the stored flag for other types', () => {
    expect(
      placeholdersEnabled({ type: 'trakt', createPlaceholdersForMissing: true })
    ).toBe(true);
    expect(
      placeholdersEnabled({
        type: 'trakt',
        createPlaceholdersForMissing: false,
      })
    ).toBe(false);
    expect(placeholdersEnabled({ type: 'trakt' })).toBe(false);
  });
});
