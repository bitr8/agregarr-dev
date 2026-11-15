export const CERTIFICATIONS_BY_COUNTRY: Record<string, string[]> = {
  US: ['NR', 'G', 'PG', 'PG-13', 'R', 'NC-17'],
  GB: ['U', 'PG', '12A', '12', '15', '18', 'R18'],
  CA: ['E', 'G', 'PG', '14A', '18A', 'R', 'A'],
};
export const CERTIFICATION_FIELDS = new Set([
  'certification',
  'certification.gte',
  'certification.lte',
]);

export const keepCountryCertifications = <
  T extends { field: string; value: string | number | boolean }
>(
  filters: T[]
): T[] => {
  const country = String(
    filters.find((f) => f.field === 'certification_country')?.value || 'US'
  );
  const allowed = new Set(
    CERTIFICATIONS_BY_COUNTRY[country] ?? CERTIFICATIONS_BY_COUNTRY.US
  );
  return filters.map((f) => {
    if (!CERTIFICATION_FIELDS.has(f.field) || !f.value) return f;
    const raw = f.value.toString();
    const kept = raw.split(/[,|]/).filter((v) => allowed.has(v));
    const value = kept.join(raw.includes('|') ? '|' : ',');
    return value === raw ? f : { ...f, value };
  });
};
