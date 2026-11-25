import { describe, expect, it } from 'vitest';
import { keepCountryCertifications } from './tmdbCertifications';

describe('keepCountryCertifications', () => {
  it('drops ratings the new country does not have', () => {
    const out = keepCountryCertifications([
      { field: 'certification_country', value: 'GB' },
      { field: 'certification', value: 'PG|PG-13|15' },
      { field: 'certification.gte', value: 'NC-17' },
    ]);
    expect(out.map((f) => f.value)).toEqual(['GB', 'PG|15', '']);
  });

  it('keeps US ratings when no country is set', () => {
    const filters = [
      { field: 'certification', value: 'PG-13,R' },
      { field: 'with_genres', value: '28' },
    ];
    expect(keepCountryCertifications(filters)).toEqual(filters);
  });
});

describe('keepCountryCertifications edge input', () => {
  it('trims spaced values', () => {
    const out = keepCountryCertifications([
      { field: 'certification_country', value: 'GB ' },
      { field: 'certification', value: 'PG | 15' },
    ]);
    expect(out[1].value).toBe('PG|15');
  });

  it('leaves ratings alone for a country it has no list for', () => {
    const filters = [
      { field: 'certification_country', value: 'AU' },
      { field: 'certification', value: 'M' },
    ];
    expect(keepCountryCertifications(filters)).toEqual(filters);
  });
});
