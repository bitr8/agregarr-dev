import type { MembershipMap } from '@server/interfaces/api/rotationInterfaces';
import useSWR from 'swr';

const EMPTY: MembershipMap = {};

export const ROTATION_MEMBERSHIP_KEY = '/api/v1/rotation-groups/membership';

const useRotationMembership = () => {
  const { data, error, mutate } = useSWR<MembershipMap>(
    ROTATION_MEMBERSHIP_KEY,
    {
      shouldRetryOnError: false,
      revalidateOnFocus: false,
    }
  );

  return {
    map: data ?? EMPTY,
    revalidate: mutate,
    isLoading: data === undefined && !error,
  };
};

export default useRotationMembership;
