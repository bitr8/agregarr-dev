import { defineMessages, useIntl } from 'react-intl';
import useSWR from 'swr';
import { COLLECTION_RANK_PREFIX } from './types';

const messages = defineMessages({
  rankCollection: 'Rank within collection',
  selectCollection: 'Select a collection...',
  plexSuffix: '(Plex)',
  rankHint:
    "Shows the item's position in this collection, in the order Plex sorts it. Items outside it get no number, and season and episode artwork never shows a rank.",
});

interface CollectionRankPickerProps {
  value: string;
  onChange: (field: string) => void;
}

interface CollectionSummary {
  id: string;
  name: string;
  libraryName: string;
  collectionRatingKeys?: string[];
  type?: string;
}

const fetcher = (url: string) => fetch(url).then((res) => res.json());

const CollectionRankPicker = ({
  value,
  onChange,
}: CollectionRankPickerProps) => {
  const intl = useIntl();
  const { data: agregarr } = useSWR<{ collectionConfigs: CollectionSummary[] }>(
    '/api/v1/collections',
    fetcher
  );
  const { data: preExisting } = useSWR<CollectionSummary[]>(
    '/api/v1/preexisting',
    fetcher
  );

  const grouped = new Map<string, { value: string; label: string }[]>();
  const add = (c: CollectionSummary, label: string) => {
    const lib = c.libraryName || 'Unknown Library';
    if (!grouped.has(lib)) grouped.set(lib, []);
    grouped.get(lib)?.push({ value: c.id, label });
  };
  for (const c of agregarr?.collectionConfigs ?? []) {
    if (
      !c.collectionRatingKeys?.length &&
      c.type !== 'filtered_hub' &&
      c.type !== 'comingsoon'
    ) {
      add(c, c.name);
    }
  }
  for (const c of Array.isArray(preExisting) ? preExisting : []) {
    add(c, `${c.name} ${intl.formatMessage(messages.plexSuffix)}`);
  }

  return (
    <div className="mt-2">
      <label className="mb-1 block text-xs text-stone-400">
        {intl.formatMessage(messages.rankCollection)}
      </label>
      <select
        value={value.slice(COLLECTION_RANK_PREFIX.length)}
        onChange={(e) => onChange(`${COLLECTION_RANK_PREFIX}${e.target.value}`)}
        className="w-full rounded border border-stone-600 bg-stone-700 px-2 py-1 text-xs text-white"
      >
        <option value="">
          {intl.formatMessage(messages.selectCollection)}
        </option>
        {Array.from(grouped.entries()).map(([lib, options]) => (
          <optgroup key={lib} label={lib}>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <p className="mt-1 text-xs text-stone-500">
        {intl.formatMessage(messages.rankHint)}
      </p>
    </div>
  );
};

export default CollectionRankPicker;
