import {
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
} from '@heroicons/react/24/outline';
import Link from 'next/link';
import useSWR from 'swr';

interface HealthStatusResponse {
  status: 'ok' | 'warning' | 'error' | 'unknown' | 'disabled';
  checkedAt: string | null;
  checks: {
    id: string;
    status: string;
    silenced: boolean;
  }[];
}

const HealthBadge = () => {
  const { data } = useSWR<HealthStatusResponse>('/api/v1/status/health', {
    refreshInterval: 60 * 1000,
  });

  if (
    !data ||
    data.status === 'ok' ||
    data.status === 'unknown' ||
    data.status === 'disabled'
  ) {
    return null;
  }

  const issueCount = data.checks.filter(
    (c) => !c.silenced && (c.status === 'warning' || c.status === 'error')
  ).length;

  if (issueCount === 0) return null;

  const hasError = data.checks.some((c) => !c.silenced && c.status === 'error');

  return (
    <Link href="/settings/about">
      <a
        role="button"
        tabIndex={0}
        className={`mx-2 mt-2 flex items-center rounded-lg p-2 text-xs ring-1 ring-gray-700 transition duration-300 ${
          hasError
            ? 'bg-red-600 text-white hover:bg-red-500'
            : 'bg-amber-600 text-white hover:bg-amber-500'
        }`}
      >
        {hasError ? (
          <ExclamationCircleIcon className="h-5 w-5 flex-shrink-0" />
        ) : (
          <ExclamationTriangleIcon className="h-5 w-5 flex-shrink-0" />
        )}
        <span className="ml-2 font-medium">
          {issueCount} health {issueCount === 1 ? 'issue' : 'issues'}
        </span>
      </a>
    </Link>
  );
};

export default HealthBadge;
