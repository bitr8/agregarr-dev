import Button from '@app/components/Common/Button';
import messages from '@app/components/Rotation/messages';
import PosterTile from '@app/components/Rotation/PosterTile';
import { ROTATION_GROUPS_URL } from '@app/hooks/rotation/useRotationGroups';
import type { SavedPreview } from '@server/interfaces/api/rotationInterfaces';
import { useEffect, useRef } from 'react';
import { useIntl } from 'react-intl';
import useSWR from 'swr';

interface PreviewNextProps {
  groupId: string;
  seq: number;
  nextSentence: string;
}

const PreviewNext = ({ groupId, seq, nextSentence }: PreviewNextProps) => {
  const intl = useIntl();
  const { data, error, mutate, isLoading } = useSWR<SavedPreview>(
    `${ROTATION_GROUPS_URL}/${groupId}/preview?steps=3`,
    { revalidateOnFocus: false }
  );
  const seenSeq = useRef(seq);

  useEffect(() => {
    if (seenSeq.current !== seq) {
      seenSeq.current = seq;
      mutate();
    }
  }, [seq, mutate]);

  const label = (i: number) =>
    i === 0
      ? nextSentence
      : intl.formatMessage(
          i === 1 ? messages.previewThen : messages.previewLater
        );

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-red-400">
          {intl.formatMessage(messages.previewError)}
        </p>
        <Button buttonSize="sm" onClick={() => mutate()}>
          {intl.formatMessage(messages.tryAgain)}
        </Button>
      </div>
    );
  } else if (isLoading || !data) {
    body = (
      <div className="animate-pulse space-y-4" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className="h-24 w-16 rounded-md bg-stone-800" />
            ))}
          </div>
        ))}
      </div>
    );
  } else if (data.steps.length === 0) {
    body = (
      <p className="text-sm text-gray-500">
        {intl.formatMessage(messages.previewNothing)}
      </p>
    );
  } else {
    body = (
      <div className="space-y-5">
        {data.steps.map((step, i) => (
          <div key={i}>
            <h5 className="mb-2 text-xs text-gray-400">{label(i)}</h5>
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
              {step.slots.map((m) => (
                <PosterTile
                  key={m.key}
                  name={m.name}
                  posterUrl={m.posterUrl}
                  size="sm"
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div
      className="mt-4 rounded-md border border-gray-800 bg-stone-900 p-4"
      aria-live="polite"
    >
      {body}
    </div>
  );
};

export default PreviewNext;
