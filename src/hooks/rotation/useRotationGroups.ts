import type { RotationGroupStatus } from '@server/interfaces/api/rotationInterfaces';
import useSWR from 'swr';

export const ROTATION_GROUPS_URL = '/api/v1/rotation-groups';

const useRotationGroups = () => {
  const { data, error, mutate, isLoading } = useSWR<{
    groups: RotationGroupStatus[];
  }>(ROTATION_GROUPS_URL, {
    refreshInterval: (latest) =>
      latest?.groups.some((g) => !g.plex.applied) ? 5000 : 60000,
  });

  return {
    groups: data?.groups,
    error,
    isLoading,
    mutate,
  };
};

export default useRotationGroups;
