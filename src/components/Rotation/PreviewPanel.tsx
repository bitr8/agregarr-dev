import Button from '@app/components/Common/Button';
import messages from '@app/components/Rotation/messages';
import PosterTile from '@app/components/Rotation/PosterTile';
import SlotShelf from '@app/components/Rotation/SlotShelf';
import type {
  MemberSummary,
  PreviewResult,
} from '@server/interfaces/api/rotationInterfaces';
import { useState } from 'react';
import { useIntl } from 'react-intl';

interface PreviewPanelProps {
  preview: PreviewResult;
  onClose: () => void;
}

const NameList = ({
  title,
  members,
}: {
  title: string;
  members: MemberSummary[];
}) => {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  if (members.length === 0) {
    return null;
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="rounded text-sm text-gray-300 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-400"
      >
        {title}
        <span className="ml-2 text-xs text-orange-300">
          {intl.formatMessage(open ? messages.hide : messages.show)}
        </span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-sm text-gray-400">
          {members.map((m) => (
            <li key={m.key}>{m.name}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

const PreviewPanel = ({ preview, onClose }: PreviewPanelProps) => {
  const intl = useIntl();

  return (
    <div
      className="mb-3 rounded-lg border border-gray-800 bg-stone-900 p-4 shadow-lg"
      aria-live="polite"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <h4 className="text-base font-medium text-white">
          {intl.formatMessage(messages.previewTitle)}
        </h4>
        <Button buttonSize="sm" onClick={onClose}>
          {intl.formatMessage(messages.previewClose)}
        </Button>
      </div>
      <SlotShelf
        caption={intl.formatMessage(messages.previewNow)}
        slots={preview.now.map((occupant, i) => ({
          index: i + 1,
          slotId: occupant.key,
          occupant,
        }))}
      />
      {preview.upNext.length > 0 && (
        <div className="mt-4">
          <h5 className="mb-2 text-sm font-medium text-gray-300">
            {intl.formatMessage(messages.previewUpNext)}
          </h5>
          <div className="flex gap-3 overflow-x-auto pb-1">
            {preview.upNext.map((m) => (
              <PosterTile
                key={m.key}
                name={m.name}
                posterUrl={m.posterUrl}
                size="sm"
              />
            ))}
          </div>
        </div>
      )}
      <NameList
        title={intl.formatMessage(messages.previewLeaving, {
          count: preview.leavingHome.length,
        })}
        members={preview.leavingHome}
      />
      <NameList
        title={intl.formatMessage(messages.previewRestored, {
          count: preview.restored.length,
        })}
        members={preview.restored}
      />
      <p className="mt-4 text-xs text-gray-500">
        {intl.formatMessage(messages.previewKept)}
      </p>
    </div>
  );
};

export default PreviewPanel;
