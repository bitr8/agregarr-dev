import Button from '@app/components/Common/Button';
import messages from '@app/components/Rotation/messages';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const RotationEmptyState = () => {
  const intl = useIntl();
  const router = useRouter();

  return (
    <div className="rounded-lg border border-dashed border-gray-700 px-6 py-12 text-center">
      <div className="mb-6 flex justify-center gap-2" aria-hidden="true">
        <div className="aspect-[2/3] w-16 rounded-md border-2 border-dashed border-gray-700" />
        <div className="aspect-[2/3] w-16 rounded-md border-2 border-dashed border-orange-500/60" />
        <div className="aspect-[2/3] w-16 rounded-md border-2 border-dashed border-gray-700" />
      </div>
      <h3 className="text-lg font-medium text-white">
        {intl.formatMessage(messages.emptyTitle)}
      </h3>
      <p className="mx-auto mt-2 max-w-md text-sm text-gray-400">
        {intl.formatMessage(messages.emptyBody)}
      </p>
      <div className="mt-6">
        <Button
          buttonType="primary"
          onClick={() => router.push('/rotation/new')}
        >
          {intl.formatMessage(messages.createRotation)}
        </Button>
      </div>
    </div>
  );
};

export default RotationEmptyState;
