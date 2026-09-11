import type { CollectionConfig } from '@server/lib/settings';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the modules that trigger TypeORM entity loading
vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/lib/collections/utils/TemplateEngine', () => ({
  templateEngine: {},
}));
vi.mock('@server/logger', () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const save = vi.fn();
const settings = {
  plex: { collectionConfigs: [] as CollectionConfig[] },
  save,
};

vi.mock('@server/lib/settings', () => ({
  getSettings: () => settings,
}));

import {
  buildPromotedSortTitle,
  buildSortTitleFromOverride,
  capPreviewItemsToMaxItems,
  clearConfigRatingKey,
  combinePreviewMissingItems,
  compactPromotedRanks,
  computeReposition,
  hasAgregarrLabel,
  isMultiCollectionPattern,
  parseTypedRepositionRank,
  PROMOTED_SORT_TITLE_RANK_WIDTH,
  resolveMultiCollectionBase,
  resolveMultiCollectionSortTitle,
  type RepositionPeer,
} from './CollectionUtilities';

const config = (overrides: Partial<CollectionConfig>): CollectionConfig =>
  ({ id: 'cfg-1', libraryId: '4', ...overrides } as CollectionConfig);

const stored = () =>
  settings.plex.collectionConfigs[0] as CollectionConfig & {
    collectionRatingKeys?: string[];
  };

describe('clearConfigRatingKey', () => {
  beforeEach(() => {
    save.mockClear();
    settings.plex.collectionConfigs = [];
  });

  it('clears a matching singular ratingKey', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKey).toBeUndefined();
    expect(save).toHaveBeenCalled();
  });

  it('leaves a singular ratingKey alone when a different key went stale', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '111111' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKey).toBe('111111');
  });

  it('does not write settings when nothing changed', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '111111' }),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(save).not.toHaveBeenCalled();
  });

  it('does not write settings when the stale key is absent from the array', () => {
    settings.plex.collectionConfigs = [
      config({
        collectionRatingKeys: ['111111', '222222'],
      } as Partial<CollectionConfig>),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(save).not.toHaveBeenCalled();
    expect(stored().collectionRatingKeys).toEqual(['111111', '222222']);
  });

  it('removes only the stale key from a multi-collection config', () => {
    // Overseerr per-user configs hold one ratingKey per user. Clearing one
    // dead collection must not discard every other user's collection.
    settings.plex.collectionConfigs = [
      config({
        collectionRatingKeys: ['111111', '398348', '222222'],
      } as Partial<CollectionConfig>),
    ];

    clearConfigRatingKey('cfg-1', '4', '398348');

    expect(stored().collectionRatingKeys).toEqual(['111111', '222222']);
  });

  it('does nothing when the libraryId does not match', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '9', '398348');

    expect(stored().collectionRatingKey).toBe('398348');
    expect(save).not.toHaveBeenCalled();
  });

  it('clears the singular key when no stale key is named (legacy callers)', () => {
    settings.plex.collectionConfigs = [
      config({ collectionRatingKey: '398348' }),
    ];

    clearConfigRatingKey('cfg-1', '4');

    expect(stored().collectionRatingKey).toBeUndefined();
  });
});

describe('hasAgregarrLabel', () => {
  it('matches the hyphenated labels parseConfigIdFromLabel rejects', () => {
    // Regression: routing multi-source deletes through parseConfigIdFromLabel
    // silently stopped removing these collections.
    expect(hasAgregarrLabel(['agregarr-multisource-10213'])).toBe(true);
    expect(hasAgregarrLabel(['Agregarr-filtered_hub-10214'])).toBe(true);
  });

  it('matches camel-case labels', () => {
    expect(hasAgregarrLabel(['AgregarrTmdb10213'])).toBe(true);
  });

  it('reads the tag shape Plex returns for raw collections', () => {
    expect(hasAgregarrLabel([{ tag: 'agregarr-multisource-1' }])).toBe(true);
    expect(hasAgregarrLabel([{ tag: 'horror' }])).toBe(false);
  });

  // The whole point: a user collection is refused however plausible it looks.
  // "Same title" and "not a smart collection" are not ownership evidence.
  it('refuses a user collection regardless of title or smart flag', () => {
    expect(hasAgregarrLabel(['favourites'])).toBe(false);
    expect(hasAgregarrLabel([])).toBe(false);
    expect(hasAgregarrLabel(undefined)).toBe(false);
  });
});

describe('isMultiCollectionPattern', () => {
  it('names every config that generates more than one collection', () => {
    expect(
      isMultiCollectionPattern({ type: 'overseerr', subtype: 'users' })
    ).toBe(true);
    expect(
      isMultiCollectionPattern({ type: 'tmdb', subtype: 'auto_franchise' })
    ).toBe(true);
    for (const subtype of [
      'genre',
      'decade',
      'resolution',
      'contentRating',
      'directors',
      'actors',
    ]) {
      expect(isMultiCollectionPattern({ type: 'plex', subtype })).toBe(true);
    }
  });

  // The presence half: everything else must store its key, or the create path
  // has nothing to recover from.
  it('lets ordinary configs store a key', () => {
    expect(
      isMultiCollectionPattern({ type: 'tmdb', subtype: 'trending' })
    ).toBe(false);
    expect(
      isMultiCollectionPattern({ type: 'overseerr', subtype: 'requests' })
    ).toBe(false);
    expect(isMultiCollectionPattern({ type: 'plex' })).toBe(false);
    expect(isMultiCollectionPattern(undefined)).toBe(false);
  });

  it('does not match on the subtype alone - the type has to match too', () => {
    expect(isMultiCollectionPattern({ type: 'plex', subtype: 'users' })).toBe(
      false
    );
    expect(
      isMultiCollectionPattern({ type: 'overseerr', subtype: 'genre' })
    ).toBe(false);
    // The standalone separator subtype is deliberately not a multi-collection
    // pattern - it's a single collection on its own, unlike the `useSeparator`
    // option nested inside genre/decade/directors/actors configs.
    expect(
      isMultiCollectionPattern({ type: 'plex', subtype: 'separator' })
    ).toBe(false);
  });
});

describe('resolveMultiCollectionSortTitle', () => {
  it('stores the typed value verbatim, with no prefix-extraction or suffix-stripping', () => {
    expect(
      resolveMultiCollectionSortTitle(
        '!00007_Auto Genre Collections',
        'Auto Genre Collections',
        false
      )
    ).toBe('!00007_Auto Genre Collections');
    expect(
      resolveMultiCollectionSortTitle('ZZZZ', 'Auto Genre Collections', false)
    ).toBe('ZZZZ');
    expect(
      resolveMultiCollectionSortTitle(
        '1Auto Genre Collection',
        'Auto Genre Collections',
        false
      )
    ).toBe('1Auto Genre Collection');
  });

  it('trims surrounding whitespace', () => {
    expect(
      resolveMultiCollectionSortTitle(
        '  !00007_Auto Genre Collections  ',
        'Auto Genre Collections',
        false
      )
    ).toBe('!00007_Auto Genre Collections');
  });

  it('returns an empty string for an empty (or whitespace-only) submission', () => {
    expect(
      resolveMultiCollectionSortTitle('', 'Auto Genre Collections', false)
    ).toBe('');
    expect(
      resolveMultiCollectionSortTitle('   ', 'Auto Genre Collections', false)
    ).toBe('');
  });

  it('clears to an empty string when unpromoted and the submission is exactly the bare config name', () => {
    // The bare name is computeAgregarrSortTitle's default for an unpromoted
    // config with no override - the form pre-fills the field with it
    // untouched. Treating that as a real override would store the name
    // itself as sortTitleOverride for no reason - the field is meant to be
    // empty until the user actually types something of their own.
    expect(
      resolveMultiCollectionSortTitle(
        'Auto Genre Collections',
        'Auto Genre Collections',
        false
      )
    ).toBe('');
  });

  it('does NOT clear the bare config name when currently promoted - it is a deliberate edit, not the untouched default', () => {
    // Regression: when promoted, the untouched default is "!rank_Name", not
    // the bare name - so typing the bare name instead means the user
    // actively stripped the promotion marker. That has to be stored and
    // flow through to the promotion-mismatch check like any other non-"!"
    // text would for a regular collection. Clearing it here would silently
    // swallow the mismatch signal entirely, since the toast's very first
    // check bails on an empty sortTitleOverride - leaving the edit with no
    // visible effect and no toast, even though it's clearly a real edit.
    expect(
      resolveMultiCollectionSortTitle(
        'Auto Genre Collections',
        'Auto Genre Collections',
        true
      )
    ).toBe('Auto Genre Collections');
  });

  it('does not clear a value that merely contains the parent name as a substring', () => {
    // Only an EXACT match against the bare name clears the field - anything
    // else, even text built around the parent name, is a real typed value.
    expect(
      resolveMultiCollectionSortTitle(
        'NotAuto Genre Collections',
        'Auto Genre Collections',
        false
      )
    ).toBe('NotAuto Genre Collections');
  });
});

describe('buildSortTitleFromOverride', () => {
  it('completes a bare prefix with the collection name', () => {
    // bitr8's documented usage and what existing #50 configs contain.
    expect(buildSortTitleFromOverride('!020_', 'Apple TV Top 10')).toBe(
      '!020_Apple TV Top 10'
    );
    expect(buildSortTitleFromOverride('ZZZ_', 'Apple TV Top 10')).toBe(
      'ZZZ_Apple TV Top 10'
    );
  });

  it('writes an already-complete title verbatim', () => {
    expect(
      buildSortTitleFromOverride('!020_Apple TV Top 10', 'Apple TV Top 10')
    ).toBe('!020_Apple TV Top 10');
  });

  it('does not double the name when a promoted collection is sent to A-Z', () => {
    // Stripping the "!003_" off the pre-filled value is how a user asks for
    // A-Z. Demote only clears "!"-prefixed overrides, so the bare name
    // survives - appending to it would write "CrowCrow" to Plex.
    expect(buildSortTitleFromOverride('Crow', 'Crow')).toBe('Crow');
    expect(buildSortTitleFromOverride('Crow', 'The Crow')).toBe('Crow');
  });

  it('appends each name after a shared prefix for multi-collection configs', () => {
    expect(buildSortTitleFromOverride('!010_', 'Action', true)).toBe(
      '!010_Action'
    );
    // Joined with an underscore so the two read apart in Plex's sort field,
    // and the separator's own "!010_Genres" stays a strict prefix of it.
    expect(buildSortTitleFromOverride('!010_Genres', 'Action', true)).toBe(
      '!010_Genres_Action'
    );
  });
});

describe('buildPromotedSortTitle', () => {
  it('zero-pads the rank to the fixed width and prefixes with !', () => {
    expect(buildPromotedSortTitle('Omega Collection', 13)).toBe(
      '!013_Omega Collection'
    );
    expect(buildPromotedSortTitle('IMDb Popular', 1)).toBe('!001_IMDb Popular');
  });

  it('clamps negative ranks to 0 rather than producing a malformed prefix', () => {
    expect(buildPromotedSortTitle('Name', -5)).toBe('!000_Name');
  });

  it("interleaves with Kometa's 3-digit convention under Plex's string sort", () => {
    // Plex sorts sortTitles as strings, so the padding width is an interop
    // contract, not cosmetics. At 5 digits '!00015_' compares below '!010_'
    // at the third character and every Agregarr collection would clump
    // ahead of every Kometa one. At 3 they interleave by rank.
    const sorted = [
      buildPromotedSortTitle('Action', 1),
      buildPromotedSortTitle('Romance', 15),
      '!010_Marvel',
      '!020_Star Wars',
    ].sort();

    expect(sorted).toEqual([
      '!001_Action',
      '!010_Marvel',
      '!015_Romance',
      '!020_Star Wars',
    ]);
  });

  it('clamps ranks that exceed the padding width rather than sorting them backwards', () => {
    // padStart does not truncate, so an unclamped rank of 1000 renders
    // "!1000_" and string-compares BEFORE "!999_" at the second character -
    // the ordering inverts silently past the boundary. Clamping keeps the
    // sequence monotonic; ranks at the cap then sort by name among
    // themselves, which is the far smaller problem.
    const maxRank = 10 ** PROMOTED_SORT_TITLE_RANK_WIDTH - 1;
    const huge = 10 ** PROMOTED_SORT_TITLE_RANK_WIDTH + 23;
    expect(buildPromotedSortTitle('Name', huge)).toBe(`!${maxRank}_Name`);
    expect(
      buildPromotedSortTitle('Name', huge) > buildPromotedSortTitle('Name', 999)
    ).toBe(false);
    expect(
      buildPromotedSortTitle('B', huge) > buildPromotedSortTitle('A', 998)
    ).toBe(true);
  });

  it('never depends on any other collection - same rank always produces the same title', () => {
    // The whole point of positional encoding: unlike an exclamation count
    // (which needs the max across every other promoted collection), a
    // rank's sortTitle is a pure function of its own two arguments.
    expect(buildPromotedSortTitle('Name', 42)).toBe(
      buildPromotedSortTitle('Name', 42)
    );
  });

  it('a promoted title always sorts before its own natural (unprefixed) name', () => {
    const natural = 'Apple Collection';
    const promoted = buildPromotedSortTitle(natural, 1);
    expect([natural, promoted].sort()[0]).toBe(promoted);
  });

  it('theoretical scale: 230 promoted collections sort in exact rank order, mixing regular and pre-existing origins', () => {
    // Simulates a library with 230 promoted collections - the scenario
    // called out for testing. Half are "regular" (Agregarr-built), half
    // are "pre-existing" - buildPromotedSortTitle takes no notion of type
    // at all, so mixing them is not a special case, just two label sets
    // sharing one rank sequence exactly like drag-and-drop already does.
    const total = 230;
    const items = Array.from({ length: total }, (_, i) => {
      const rank = i + 1; // sortOrderLibrary is 1-indexed in practice
      const origin = rank % 2 === 0 ? 'PreExisting' : 'Regular';
      const name = `${origin} Collection ${rank}`;
      return { rank, name, sortTitle: buildPromotedSortTitle(name, rank) };
    });

    const sortedByTitle = [...items].sort((a, b) =>
      a.sortTitle < b.sortTitle ? -1 : a.sortTitle > b.sortTitle ? 1 : 0
    );

    expect(sortedByTitle.map((i) => i.rank)).toEqual(items.map((i) => i.rank));
  });

  it('theoretical scale: adding a 231st promoted collection to a 230-item library changes no existing sortTitle', () => {
    // The concrete failure mode this redesign eliminates: under the old
    // exclamation-count scheme, every existing collection's count was
    // computed relative to the max sortOrderLibrary across the whole
    // library, so adding one more promoted collection at the bottom
    // (raising that max) required rewriting every other collection's
    // sortTitle too. Positional encoding has no such dependency.
    const total = 230;
    const before = Array.from({ length: total }, (_, i) => {
      const rank = i + 1;
      return buildPromotedSortTitle(`Collection ${rank}`, rank);
    });

    // A 231st collection joins at the bottom - nobody else's rank changes.
    const after = Array.from({ length: total }, (_, i) => {
      const rank = i + 1;
      return buildPromotedSortTitle(`Collection ${rank}`, rank);
    });
    buildPromotedSortTitle('Collection 231', total + 1); // the new arrival

    expect(after).toEqual(before);
  });
});

describe('parseTypedRepositionRank', () => {
  it('parses a rank out of exactly what buildPromotedSortTitle would produce for that collection', () => {
    const sortTitle = buildPromotedSortTitle('IMDb Popular', 19);
    expect(parseTypedRepositionRank(sortTitle)).toBe(19);
  });

  it('is not fooled by leading zeros - "000019" parses the same as "00019"', () => {
    expect(parseTypedRepositionRank('!000019_Name')).toBe(19);
  });

  it('trims surrounding whitespace before parsing', () => {
    expect(parseTypedRepositionRank('  !00019_Name  ')).toBe(19);
  });

  it('parses the rank even when the trailing text is not this collection name', () => {
    // Requiring an exact name match meant editing the rank and the text
    // together ("!00031_Killers" -> "!00033_Thrillers") silently did
    // nothing at all, which reads as broken - the rank plainly changed, so
    // the collection should plainly move. The trailing text is discarded
    // regardless, since a promoted collection's sortTitle is recomputed
    // positionally from its real name.
    expect(parseTypedRepositionRank('!00033_Thrillers')).toBe(33);
    expect(parseTypedRepositionRank('!00019_Some Other Name')).toBe(19);
  });

  it('returns undefined for arbitrary literal overrides that do not follow the rank format', () => {
    expect(parseTypedRepositionRank('0Force This First')).toBeUndefined();
    expect(parseTypedRepositionRank('')).toBeUndefined();
    expect(parseTypedRepositionRank('IMDb Popular')).toBeUndefined();
  });

  it('rejects a rank of 0 - ranks are 1-indexed, and 0 has no valid target position', () => {
    expect(parseTypedRepositionRank('!00000_Name')).toBeUndefined();
  });

  it('rejects a negative-looking rank - the leading "-" breaks the digit-only match', () => {
    expect(parseTypedRepositionRank('!-5_Name')).toBeUndefined();
  });

  it('requires the underscore separator - digits butted against the name are not a match', () => {
    expect(parseTypedRepositionRank('!00019Name')).toBeUndefined();
  });

  it('is the exact inverse of buildPromotedSortTitle across every representable rank', () => {
    // Only up to the clamp: past it buildPromotedSortTitle deliberately
    // stops being injective, so a round trip cannot recover the original.
    for (const rank of [1, 2, 5, 19, 100, 999]) {
      const sortTitle = buildPromotedSortTitle('Some Collection', rank);
      expect(parseTypedRepositionRank(sortTitle)).toBe(rank);
    }
  });

  it('reads a clamped rank back as the cap, not the value that was asked for', () => {
    const maxRank = 10 ** PROMOTED_SORT_TITLE_RANK_WIDTH - 1;
    const sortTitle = buildPromotedSortTitle('Some Collection', 99999);
    expect(parseTypedRepositionRank(sortTitle)).toBe(maxRank);
  });
});

describe('computeReposition', () => {
  const peer = (
    id: string,
    sortOrderLibrary: number,
    libraryId = '10'
  ): RepositionPeer => ({
    id,
    libraryId,
    sortOrderLibrary,
    isLibraryPromoted: true,
  });

  it('moving a regular collection down still accounts for pre-existing and hub peers sharing the same rank sequence', () => {
    // Regression test for the actual bug: a manual reposition computed
    // only against the caller's own config array (e.g. collectionConfigs)
    // silently collided with ranks held by pre-existing collections and
    // hubs in the same library, because all three types share one
    // sortOrderLibrary numbering space (see reorder.ts, which already
    // combines all three for drag-and-drop). 21 regular collections at
    // ranks 1-21 plus 10 pre-existing collections at ranks 22-31 is the
    // exact shape that exposed it.
    const allPeers: RepositionPeer[] = [
      ...Array.from({ length: 21 }, (_, i) => peer(`c${i + 1}`, i + 1)),
      ...Array.from({ length: 10 }, (_, i) => peer(`p${i + 1}`, i + 22)),
    ];

    // Move "c1" (rank 1) down to rank 25 - squarely inside the
    // pre-existing collections' range, which a collections-only peer
    // search would never have known existed.
    const result = computeReposition('c1', '10', 25, allPeers);

    expect(result.targetNewRank).toBe(25);

    // Everything from rank 2 through 25 shifts down by one to make room;
    // nothing at rank 26+ moves, since it was never between the old and
    // new position.
    const updatesById = new Map(
      result.peerUpdates.map((u) => [u.id, u.sortOrderLibrary])
    );
    expect(updatesById.get('c2')).toBe(1);
    expect(updatesById.get('c21')).toBe(20);
    expect(updatesById.get('p1')).toBe(21); // was rank 22
    expect(updatesById.get('p4')).toBe(24); // was rank 25
    expect(updatesById.has('p5')).toBe(false); // was rank 26, stays 26
    expect(updatesById.has('p10')).toBe(false); // was rank 31, stays 31

    // No two peers (or the moved item) ever land on the same rank.
    const allRanks = [
      result.targetNewRank,
      ...result.peerUpdates.map((u) => u.sortOrderLibrary),
    ];
    expect(new Set(allRanks).size).toBe(allRanks.length);
  });

  it('places a currently-unpromoted target at the requested rank, not just at the bottom', () => {
    // Backs PATCH /:id/promote's targetRank: a collection sitting in A-Z
    // is not among allPeers (nothing unpromoted is), yet confirming the
    // promotion prompt has to land it at the rank the user typed rather
    // than appending to the bottom. computeReposition supports that
    // natively - it only excludes the target by id, never by the target's
    // own isLibraryPromoted flag - so a target absent from allPeers still
    // splices in correctly.
    const allPeers: RepositionPeer[] = Array.from({ length: 5 }, (_, i) =>
      peer(`c${i + 1}`, i + 1)
    );

    const result = computeReposition('demoted-item', '10', 1, allPeers);

    expect(result.targetNewRank).toBe(1);
    const updatesById = new Map(
      result.peerUpdates.map((u) => [u.id, u.sortOrderLibrary])
    );
    expect(updatesById.get('c1')).toBe(2);
    expect(updatesById.get('c5')).toBe(6);
  });

  it('ignores peers from a different library entirely', () => {
    const allPeers: RepositionPeer[] = [
      peer('same-lib-1', 1, '10'),
      peer('same-lib-2', 2, '10'),
      peer('other-lib-1', 1, '14'),
      peer('other-lib-2', 2, '14'),
    ];

    const result = computeReposition('same-lib-1', '10', 2, allPeers);

    expect(result.peerUpdates.some((u) => u.id.startsWith('other-lib'))).toBe(
      false
    );
  });

  it('excludes non-promoted peers from the reordering pool', () => {
    const allPeers: RepositionPeer[] = [
      peer('promoted-1', 1),
      {
        id: 'az-item',
        libraryId: '10',
        sortOrderLibrary: 0,
        isLibraryPromoted: false,
      },
      peer('promoted-2', 2),
    ];

    const result = computeReposition('promoted-1', '10', 2, allPeers);

    expect(result.peerUpdates.some((u) => u.id === 'az-item')).toBe(false);
  });

  it('clamps a requested rank beyond the promoted pool to the bottom', () => {
    const allPeers: RepositionPeer[] = Array.from({ length: 5 }, (_, i) =>
      peer(`c${i + 1}`, i + 1)
    );

    const result = computeReposition('c1', '10', 999, allPeers);

    // 4 other peers remain after excluding the target itself, so the
    // bottom slot is 5.
    expect(result.targetNewRank).toBe(5);
  });

  it('only returns peers whose rank actually changed - moving to the adjacent slot touches at most one peer', () => {
    const allPeers: RepositionPeer[] = Array.from({ length: 10 }, (_, i) =>
      peer(`c${i + 1}`, i + 1)
    );

    // c1 is at rank 1; moving it to rank 2 only needs c2 to shift to 1.
    const result = computeReposition('c1', '10', 2, allPeers);

    expect(result.peerUpdates).toHaveLength(1);
    expect(result.peerUpdates[0]).toEqual({ id: 'c2', sortOrderLibrary: 1 });
  });

  it('requesting the same rank the item already effectively holds produces no peer updates', () => {
    const allPeers: RepositionPeer[] = Array.from({ length: 5 }, (_, i) =>
      peer(`c${i + 1}`, i + 1)
    );

    // c3 is at rank 3; the caller is responsible for not calling this when
    // requestedRank === current rank, but if it did, nothing should move.
    const result = computeReposition('c3', '10', 3, allPeers);

    expect(result.peerUpdates).toHaveLength(0);
    expect(result.targetNewRank).toBe(3);
  });
});

describe('compactPromotedRanks', () => {
  const peer = (
    id: string,
    sortOrderLibrary: number,
    isLibraryPromoted = true
  ): RepositionPeer => ({
    id,
    libraryId: '10',
    sortOrderLibrary,
    isLibraryPromoted,
  });

  it('closes a gap left behind by demoting whatever held rank 1', () => {
    // Regression: /demote only ever cleared the demoted item's own rank -
    // nothing shifted down to fill the hole, so the "top" rank drifted
    // further from 1 with every demote. This is the exact shape that bug
    // produces: ranks 2-4 populated, nothing at 1.
    const remainingPeers = [peer('c2', 2), peer('c3', 3), peer('c4', 4)];

    const updates = compactPromotedRanks(remainingPeers);

    expect(updates).toEqual(
      expect.arrayContaining([
        { id: 'c2', sortOrderLibrary: 1 },
        { id: 'c3', sortOrderLibrary: 2 },
        { id: 'c4', sortOrderLibrary: 3 },
      ])
    );
    expect(updates).toHaveLength(3);
  });

  it('produces no updates when ranks are already contiguous from 1', () => {
    const peers = [peer('c1', 1), peer('c2', 2), peer('c3', 3)];

    expect(compactPromotedRanks(peers)).toHaveLength(0);
  });

  it('excludes non-promoted peers from the compaction entirely', () => {
    const peers = [
      peer('c1', 1),
      peer('az-item', 0, false),
      peer('c2', 5), // gap between 1 and 5, should still compact to 2
    ];

    const updates = compactPromotedRanks(peers);

    expect(updates.some((u) => u.id === 'az-item')).toBe(false);
    expect(updates).toEqual([{ id: 'c2', sortOrderLibrary: 2 }]);
  });

  it('mixes peer types transparently, same as computeReposition', () => {
    const peers = [
      peer('regular-1', 3),
      peer('preexisting-1', 5),
      peer('hub-1', 9),
    ];

    const updates = compactPromotedRanks(peers);

    expect(updates).toEqual(
      expect.arrayContaining([
        { id: 'regular-1', sortOrderLibrary: 1 },
        { id: 'preexisting-1', sortOrderLibrary: 2 },
        { id: 'hub-1', sortOrderLibrary: 3 },
      ])
    );
  });
});

describe('capPreviewItemsToMaxItems', () => {
  // Preview must show what the sync will do: matched items are capped by
  // count, missing items by source position, independently.
  const matched = Array.from({ length: 61 }, (_, i) => ({
    ratingKey: `rk-${i}`,
  }));
  const missing = [{ originalPosition: 5 }, { originalPosition: 40 }];

  it('caps matched items by count', () => {
    const result = capPreviewItemsToMaxItems(matched, missing, 30);
    expect(result.items).toHaveLength(30);
  });

  it('keeps missing items inside the cap even when matched fills it', () => {
    const result = capPreviewItemsToMaxItems(matched, missing, 30);
    expect(result.missingItems).toEqual([{ originalPosition: 5 }]);
  });

  it('does not cap when maxItems is unset', () => {
    const result = capPreviewItemsToMaxItems(matched, missing, undefined);
    expect(result.items).toHaveLength(61);
    expect(result.missingItems).toHaveLength(2);
  });
});

describe('combinePreviewMissingItems', () => {
  it('position-filters each source before dedupe so an in-cap duplicate survives', () => {
    const a = [{ tmdbId: 1, mediaType: 'movie', originalPosition: 40 }];
    const b = [
      { tmdbId: 1, mediaType: 'movie', originalPosition: 5 },
      { tmdbId: 2, mediaType: 'movie', originalPosition: 31 },
    ];
    expect(combinePreviewMissingItems([a, b], 30)).toEqual([
      { tmdbId: 1, mediaType: 'movie', originalPosition: 5 },
    ]);
  });
});

describe('multi-collection group sort titles', () => {
  // The full matrix a group can be in. A group is a parent config that
  // generates many collections plus an optional separator heading them; the
  // thing that must hold in every row is that the separator is a strict
  // string prefix of its members, so it sorts immediately ahead of the block
  // rather than into it or away from it.
  const GROUP = 'Auto Genre Collections';

  const memberTitle = (base: string | undefined, member: string) =>
    base ? buildSortTitleFromOverride(base, member, true) : member;

  describe('base resolution', () => {
    it('prefers a typed override', () => {
      expect(resolveMultiCollectionBase('ZZZ Group', GROUP)).toBe('ZZZ Group');
    });

    it('falls back to the group name so a demoted group still coheres', () => {
      expect(resolveMultiCollectionBase(undefined, GROUP)).toBe(GROUP);
      expect(resolveMultiCollectionBase('', GROUP)).toBe(GROUP);
      expect(resolveMultiCollectionBase('   ', GROUP)).toBe(GROUP);
    });

    it('has nothing to fall back to when the caller withholds the name', () => {
      // How a promoted group opts out: its shared rank already groups it.
      expect(resolveMultiCollectionBase(undefined, undefined)).toBeUndefined();
      expect(resolveMultiCollectionBase('', '  ')).toBeUndefined();
    });
  });

  describe('demoted, no override', () => {
    const base = resolveMultiCollectionBase(undefined, GROUP);

    it('separates and groups under the group name', () => {
      expect(base).toBe('Auto Genre Collections');
      expect(memberTitle(base, 'Music')).toBe('Auto Genre Collections_Music');
      expect(memberTitle(base, 'Western')).toBe(
        'Auto Genre Collections_Western'
      );
    });

    it('keeps the separator a strict prefix of every member', () => {
      for (const member of ['Music', 'Western', 'Anime']) {
        expect(memberTitle(base, member).startsWith(base as string)).toBe(true);
        expect(memberTitle(base, member)).not.toBe(base);
      }
    });
  });

  describe('demoted, with an override', () => {
    const base = resolveMultiCollectionBase('AAuto Genre Collections', GROUP);

    it('uses the override for the separator and every member', () => {
      expect(base).toBe('AAuto Genre Collections');
      expect(memberTitle(base, 'Music')).toBe('AAuto Genre Collections_Music');
    });

    it('never doubles the separator name onto the base', () => {
      // The reported bug: the separator came out as the base with its own
      // title run onto the end - "AAuto Genre CollectionsGenre Collections" -
      // which is neither a prefix of its members nor sorted with them.
      expect(base).not.toContain('Genre CollectionsGenre');
      expect(base as string).not.toBe(`${base}Genre Collections`);
    });
  });

  describe('a bare prefix completes itself with each name', () => {
    const base = resolveMultiCollectionBase('!040_', GROUP);

    it('appends directly, with no extra underscore', () => {
      expect(memberTitle(base, 'Music')).toBe('!040_Music');
      expect(memberTitle(base, 'Western')).toBe('!040_Western');
    });
  });

  describe('promoted groups are grouped by their rank instead', () => {
    it('takes no fallback base, so members keep their own names', () => {
      const base = resolveMultiCollectionBase(undefined, undefined);
      expect(base).toBeUndefined();
      expect(memberTitle(base, 'Music')).toBe('Music');
    });

    it('and every member shares the one rank prefix', () => {
      expect(buildPromotedSortTitle('Music', 40)).toBe('!040_Music');
      expect(buildPromotedSortTitle('Western', 40)).toBe('!040_Western');
    });

    it('puts a separator ahead of them, since ! sorts before any letter', () => {
      const separator = buildPromotedSortTitle('!Genre Collections', 40);
      expect(separator).toBe('!040_!Genre Collections');
      expect(separator < buildPromotedSortTitle('Music', 40)).toBe(true);
    });
  });

  describe('ordering holds as a whole', () => {
    it('sorts separator first, then members alphabetically', () => {
      const base = resolveMultiCollectionBase(undefined, GROUP) as string;
      const sorted = [
        memberTitle(base, 'Western'),
        base,
        memberTitle(base, 'Music'),
      ].sort();
      expect(sorted).toEqual([
        'Auto Genre Collections',
        'Auto Genre Collections_Music',
        'Auto Genre Collections_Western',
      ]);
    });

    it('keeps an overridden group together and away from unrelated names', () => {
      const base = resolveMultiCollectionBase('MMM Group', GROUP) as string;
      const sorted = [
        'Marvel',
        memberTitle(base, 'Music'),
        'Mystery',
        base,
      ].sort();
      expect(sorted).toEqual([
        'MMM Group',
        'MMM Group_Music',
        'Marvel',
        'Mystery',
      ]);
    });
  });
});
