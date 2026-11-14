import useSWR from 'swr';

const useSyncRunning = (): boolean => {
  const { data } = useSWR<{ running: boolean }>(
    '/api/v1/collections/sync/status',
    { refreshInterval: (latest) => (latest?.running ? 1000 : 5000) }
  );
  return !!data?.running;
};

export default useSyncRunning;
