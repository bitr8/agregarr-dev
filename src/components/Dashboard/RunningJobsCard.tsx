import axios from 'axios';
import useSWR from 'swr';
import LibraryProgressCard, {
  type LibraryStatus,
} from '@app/components/PostersView/LibraryProgressCard';

interface RunningLibrariesResponse {
  runningLibraries: LibraryStatus[];
}

const RunningJobsCard: React.FC = () => {
  const { data, mutate } = useSWR<RunningLibrariesResponse>(
    '/api/v1/overlay-library-configs/status/all',
    {
      refreshInterval: 1000,
    }
  );

  const runningJobs =
    data?.runningLibraries.filter(
      (lib) => lib.state === 'running' || lib.state === 'stopping'
    ) || [];

  const handleStop = async (libraryId: string) => {
    try {
      await axios.post(`/api/v1/overlay-library-configs/${libraryId}/stop`);
      mutate();
    } catch (error) {
      console.error('Failed to stop job:', error);
    }
  };

  if (runningJobs.length === 0) {
    return null;
  }

  return (
    <div className="mb-6">
      <h3 className="mb-4 text-lg font-semibold text-white">Running Jobs</h3>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {runningJobs.map((lib) => (
          <LibraryProgressCard
            key={lib.libraryId}
            status={lib}
            onStop={() => handleStop(lib.libraryId)}
          />
        ))}
      </div>
    </div>
  );
};

export default RunningJobsCard;
