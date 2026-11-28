import {
  PosterizarrTriggerJob,
  runCollectionsQuickSyncForItem,
} from '@server/lib/posterizarrTrigger';

const placeholderSwapJob = new PosterizarrTriggerJob(
  (input) => runCollectionsQuickSyncForItem(input.ratingKey),
  5 * 60_000,
  50,
  'placeholder swap trigger',
  'Placeholder Swap'
);

export default placeholderSwapJob;
