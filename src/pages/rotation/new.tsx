import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RotationEditor from '@app/components/Rotation/RotationEditor';
import { useUser } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const NewRotation: NextPage = () => {
  const { user } = useUser();

  if (!user) {
    return <LoadingSpinner />;
  }

  return <RotationEditor />;
};

export default NewRotation;
