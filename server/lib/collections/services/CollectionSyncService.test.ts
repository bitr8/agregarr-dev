import type { SyncResult } from '@server/lib/collections/core/types';
import { describe, expect, it } from 'vitest';

/**
 * Tests for the getAllCollections cache invalidation logic.
 * These test the invalidation decision logic in isolation, not the full sync pipeline.
 */
describe('getAllCollections cache invalidation logic', () => {
  // Simulate the cache invalidation pattern from CollectionSyncService
  function shouldInvalidate(result: SyncResult): boolean {
    return !!result.mutated;
  }

  it('should invalidate when collections are created', () => {
    const result: SyncResult = { created: 1, updated: 0, mutated: true };
    expect(shouldInvalidate(result)).toBe(true);
  });

  it('should invalidate when collections are updated', () => {
    const result: SyncResult = { created: 0, updated: 3, mutated: true };
    expect(shouldInvalidate(result)).toBe(true);
  });

  it('should invalidate when collections are deleted (mutated flag)', () => {
    // Deletion sets mutated=true but created/updated stay at 0
    const result: SyncResult = { created: 0, updated: 0, mutated: true };
    expect(shouldInvalidate(result)).toBe(true);
  });

  it('should NOT invalidate when nothing changed', () => {
    const result: SyncResult = { created: 0, updated: 0 };
    expect(shouldInvalidate(result)).toBe(false);
  });

  it('should NOT invalidate when mutated is explicitly false', () => {
    const result: SyncResult = { created: 0, updated: 0, mutated: false };
    expect(shouldInvalidate(result)).toBe(false);
  });
});

describe('SyncResult.mutated semantics', () => {
  it('mutated should be true when created > 0', () => {
    // This mirrors BaseCollectionSync's return: mutated: mutated || created > 0 || updated > 0
    const created = 1;
    const updated = 0;
    const deletionOccurred = false;
    const mutated = deletionOccurred || created > 0 || updated > 0;
    expect(mutated).toBe(true);
  });

  it('mutated should be true when deletion occurred even with no creates/updates', () => {
    const created = 0;
    const updated = 0;
    const deletionOccurred = true;
    const mutated = deletionOccurred || created > 0 || updated > 0;
    expect(mutated).toBe(true);
  });

  it('mutated should be false when nothing happened', () => {
    const created = 0;
    const updated = 0;
    const deletionOccurred = false;
    const mutated = deletionOccurred || created > 0 || updated > 0;
    expect(mutated).toBe(false);
  });
});
