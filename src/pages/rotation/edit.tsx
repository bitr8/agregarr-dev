import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import RotationEditor from '@app/components/Rotation/RotationEditor';
import { useUser } from '@app/hooks/useUser';
import type { NextPage } from 'next';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';

const EditRotation: NextPage = () => {
  const { user } = useUser();
  const router = useRouter();
  const [mounted, setMounted] = useState(false);
  const groupId = router.query.id;

  useEffect(() => setMounted(true), []);

  if (!mounted || !user || typeof groupId !== 'string') {
    return <LoadingSpinner />;
  }

  return <RotationEditor groupId={groupId} />;
};

export default EditRotation;
