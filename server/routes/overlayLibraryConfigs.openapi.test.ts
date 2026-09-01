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

describe('overlay outcome details OpenAPI contract', () => {
  it('registers the route before runtime validation can reject it', () => {
    const apiSpec = yaml.load(
      fs.readFileSync(path.resolve(process.cwd(), 'agregarr-api.yml'), 'utf8')
    ) as OpenApiDocument;
    const operation =
      apiSpec.paths?.['/overlay-library-configs/status/outcomes']?.get;

    expect(operation).toBeDefined();
    expect(operation?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'outcome', required: true }),
      ])
    );
    expect(
      apiSpec.paths?.['/overlay-library-configs/status/outcomes/export']?.get
    ).toBeDefined();
  });
});
