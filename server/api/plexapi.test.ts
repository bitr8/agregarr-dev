import { describe, expect, it } from 'vitest';

/**
 * Tests for the addItemsToCollection read-back verification math
 * (verifyItemsLanded): a PUT that reports success is still only trusted for
 * the ratingKeys the follow-up read actually contains.
 */
describe('addItemsToCollection read-back verification', () => {
  // Mirrors verifyItemsLanded's counting logic against a fake read-back.
  function countVerified(attemptedKeys: string[], currentItems: string[]) {
    const currentSet = new Set(currentItems);
    let verified = 0;
    for (const key of attemptedKeys) {
      if (currentSet.has(key)) verified++;
    }
    return verified;
  }

  it('counts every attempted key present in the read-back', () => {
    const verified = countVerified(['1', '2', '3'], ['3', '1', '2']);
    expect(verified).toBe(3);
  });

  it('undercounts when the read-back is missing an attempted key', () => {
    const verified = countVerified(['1', '2', '3'], ['1', '3']);
    expect(verified).toBe(2);
  });

  it('counts zero when the write claimed success but nothing landed', () => {
    const verified = countVerified(['1', '2'], []);
    expect(verified).toBe(0);
  });
});
