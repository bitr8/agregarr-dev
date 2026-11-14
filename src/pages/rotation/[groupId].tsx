import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RotationEditor from '@app/components/Rotation/RotationEditor';
import { useUser } from '@app/hooks/useUser';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';

const EditRotation: NextPage = () => {
  const { user } = useUser();
  const router = useRouter();
  const groupId = router.query.groupId;

  if (!user || typeof groupId !== 'string') {
    return <LoadingSpinner />;
  }

  return <RotationEditor groupId={groupId} />;
};

export default EditRotation;
