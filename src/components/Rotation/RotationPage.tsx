import Alert from '@app/components/Common/Alert';
import Button from '@app/components/Common/Button';
import PageTitle from '@app/components/Common/PageTitle';
import messages from '@app/components/Rotation/messages';
import RotationEmptyState from '@app/components/Rotation/RotationEmptyState';
import RotationGroupCard from '@app/components/Rotation/RotationGroupCard';
import useSyncRunning from '@app/components/Rotation/useSyncRunning';
import useRotationGroups from '@app/hooks/rotation/useRotationGroups';
import { useRouter } from 'next/router';
import { useIntl } from 'react-intl';

const SkeletonCard = () => (
  <div
    className="animate-pulse rounded-lg border border-gray-800 bg-stone-900/60 p-4 sm:p-6"
    aria-hidden="true"
  >
    <div className="h-5 w-40 rounded bg-stone-700" />
    <div className="mt-6 flex gap-3">
      {[0, 1, 2, 3, 4].map((i) => (
        <div key={i} className="aspect-[2/3] w-28 rounded-md bg-stone-800" />
      ))}
    </div>
  </div>
);

const RotationPage = () => {
  const intl = useIntl();
  const router = useRouter();
  const { groups, error, isLoading, mutate } = useRotationGroups();
  const syncRunning = useSyncRunning();

  let body: React.ReactNode;
  if (error && !groups) {
    body = (
      <>
        <Alert type="error" title={intl.formatMessage(messages.loadError)} />
        <Button onClick={() => mutate()}>
          {intl.formatMessage(messages.tryAgain)}
        </Button>
      </>
    );
  } else if (isLoading || !groups) {
    body = (
      <div className="space-y-6" role="status">
        <span className="sr-only">
          {intl.formatMessage(messages.loadingLabel)}
        </span>
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  } else if (groups.length === 0) {
    body = <RotationEmptyState />;
  } else {
    body = (
      <div className="space-y-6">
        {groups.map((group) => (
          <RotationGroupCard
            key={group.id}
            group={group}
            syncRunning={syncRunning}
            onChanged={() => mutate()}
          />
        ))}
      </div>
    );
  }

  return (
    <>
      <PageTitle title={intl.formatMessage(messages.pageTitle)} />
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h3 className="heading text-white">
            {intl.formatMessage(messages.pageTitle)}
          </h3>
          <p className="description">
            {intl.formatMessage(messages.pageDescription)}
          </p>
        </div>
        {groups && groups.length > 0 && (
          <Button
            buttonType="primary"
            onClick={() => router.push('/rotation/new')}
          >
            {intl.formatMessage(messages.newRotation)}
          </Button>
        )}
      </div>
      {body}
    </>
  );
};

export default RotationPage;
