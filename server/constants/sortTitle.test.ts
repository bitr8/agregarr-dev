import { describe, expect, it } from 'vitest';
import { applyCollectionSuffix } from './sortTitle';

describe('applyCollectionSuffix', () => {
  it('leaves the title alone by default', () => {
    expect(applyCollectionSuffix('The Matrix Collection', undefined)).toBe(
      'The Matrix Collection'
    );
    expect(applyCollectionSuffix('Alien', 'leave')).toBe('Alien');
  });

  it('strips the suffix, and does nothing once it is gone', () => {
    expect(applyCollectionSuffix('The Matrix Collection', 'strip')).toBe(
      'The Matrix'
    );
    expect(applyCollectionSuffix('The Matrix', 'strip')).toBe('The Matrix');
  });

  it('adds the suffix, and does nothing once it is there', () => {
    expect(applyCollectionSuffix('Alien', 'add')).toBe('Alien Collection');
    expect(applyCollectionSuffix('Alien Collection', 'add')).toBe(
      'Alien Collection'
    );
  });

  it('never strips a title down to nothing', () => {
    expect(applyCollectionSuffix(' Collection', 'strip')).toBe(' Collection');
    expect(applyCollectionSuffix('Collection', 'strip')).toBe('Collection');
    expect(applyCollectionSuffix('', 'add')).toBe('');
  });

  it('matches the suffix in any case', () => {
    expect(applyCollectionSuffix('Star Wars collection', 'strip')).toBe(
      'Star Wars'
    );
    expect(applyCollectionSuffix('Star Wars COLLECTION', 'add')).toBe(
      'Star Wars COLLECTION'
    );
  });

  it('strips every trailing suffix in one pass', () => {
    expect(applyCollectionSuffix('Alien Collection Collection', 'strip')).toBe(
      'Alien'
    );
    expect(applyCollectionSuffix('Alien collection Collection ', 'strip')).toBe(
      'Alien'
    );
  });

  it('does not add a suffix to a title that is just the word', () => {
    expect(applyCollectionSuffix('Collection', 'add')).toBe('Collection');
    expect(applyCollectionSuffix('collection', 'add')).toBe('collection');
  });
});
