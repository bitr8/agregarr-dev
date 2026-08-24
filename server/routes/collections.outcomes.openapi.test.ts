import fs from 'fs';
import yaml from 'js-yaml';
import path from 'path';
import { describe, expect, it } from 'vitest';

interface OpenApiDocument {
  paths?: Record<
    string,
    {
      get?: {
        parameters?: { name?: string; required?: boolean }[];
      };
    }
  >;
}

describe('collection outcome details OpenAPI contract', () => {
  it('registers the detail and CSV routes for runtime validation', () => {
    const apiSpec = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'agregarr-api.yml'), 'utf8')
    ) as OpenApiDocument;
    const operation = apiSpec.paths?.['/collections/sync/outcomes']?.get;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'outcome', required: true }),
      ])
    );
    expect(
      apiSpec.paths?.['/collections/sync/outcomes/export']?.get
    ).toBeDefined();
  });
});
