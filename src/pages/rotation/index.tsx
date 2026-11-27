import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RotationPage from '@app/components/Rotation/RotationPage';
import { useUser } from '@app/hooks/useUser';
import type { NextPage } from 'next';

const Rotation: NextPage = () => {
  const { user } = useUser();

  if (!user) {
    return <LoadingSpinner />;
  }

  return <RotationPage />;
};

export default Rotation;
