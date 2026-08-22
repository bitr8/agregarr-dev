import {
  toCollectionCreateRequest,
  type CollectionFormConfig,
} from '@app/types/collections';
import { describe, expect, it } from 'vitest';

const baseConfig: CollectionFormConfig = {
  id: '',
  name: 'Test Collection',
  type: 'mdblist',
  subtype: 'custom',
  mdblistCustomListUrl:
    'https://mdblist.com/lists/hdlists/top-ten-pirated-movies-of-the-week-torrent-freak-com',
} as CollectionFormConfig;

describe('toCollectionCreateRequest', () => {
  it('carries mdblistCustomListUrl through the create-request transform', () => {
    const result = toCollectionCreateRequest(baseConfig);
    expect(result.mdblistCustomListUrl).toBe(baseConfig.mdblistCustomListUrl);
  });
});
