import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Button from '@app/components/Common/Button';
import ExportDebugModal from '@app/components/Common/ExportDebugModal';
import List from '@app/components/Common/List';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import globalMessages from '@app/i18n/globalMessages';
import Error from '@app/pages/_error';
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationCircleIcon,
  ExclamationTriangleIcon,
  MinusCircleIcon,
  SpeakerWaveIcon,
  SpeakerXMarkIcon,
} from '@heroicons/react/24/outline';
import {
  ArrowDownTrayIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/solid';
import type {
  SettingsAboutResponse,
  StatusResponse,
} from '@server/interfaces/api/settingsInterfaces';
import axios from 'axios';
import { useState } from 'react';
import { defineMessages, FormattedRelativeTime, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';

const messages = defineMessages({
  about: 'About',
  agregarrinformation: 'About Agregarr',
  version: 'Version',
  gettingsupport: 'Getting Support',
  githubissues: 'GitHub Issues',
  agregarrdocs: 'Agregarr Documentation',
  exportdebug: 'Export Debugging Information',
  timezone: 'Time Zone',
  appDataPath: 'Data Directory',
  outofdate: 'Out of Date',
  uptodate: 'Up to Date',
  betawarning:
    'This is BETA software. Features may be broken and/or unstable. Please report any issues on GitHub!',
  runningDevelop:
    'You are running the <code>develop</code> branch of Agregarr, which is only recommended for those contributing to development or assisting with bleeding-edge testing.',
  exportDebugInfo: 'Export Debugging Info',
});

interface HealthCheckResult {
  id: string;
  name: string;
  status: 'ok' | 'warning' | 'error' | 'skipped';
  message?: string;
  durationMs: number;
  checkedAt: string;
  silenced: boolean;
}

interface HealthStatusResponse {
  status: 'ok' | 'warning' | 'error' | 'unknown' | 'disabled';
  checkedAt: string | null;
  checks: HealthCheckResult[];
}

const statusIcon = (status: string) => {
  switch (status) {
    case 'ok':
      return <CheckCircleIcon className="h-5 w-5 text-green-500" />;
    case 'warning':
      return <ExclamationTriangleIcon className="h-5 w-5 text-amber-500" />;
    case 'error':
      return <ExclamationCircleIcon className="h-5 w-5 text-red-500" />;
    default:
      return <MinusCircleIcon className="h-5 w-5 text-gray-500" />;
  }
};

const SettingsAbout = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const [showExportModal, setShowExportModal] = useState(false);
  const { data, error } = useSWR<SettingsAboutResponse>(
    '/api/v1/settings/about'
  );

  const { data: status } = useSWR<StatusResponse>('/api/v1/status');

  const { data: health, mutate: revalidateHealth } =
    useSWR<HealthStatusResponse>('/api/v1/status/health', {
      refreshInterval: 60 * 1000,
    });

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  if (!data) {
    return <Error statusCode={500} />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.about),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mt-6 rounded-md border border-orange-500 bg-orange-400 bg-opacity-20 p-4 backdrop-blur">
        <div className="flex">
          <div className="flex-shrink-0">
            <InformationCircleIcon className="h-5 w-5 text-gray-100" />
          </div>
          <div className="ml-3 flex-1 md:flex md:justify-between">
            <p className="text-sm leading-5 text-gray-100">
              {intl.formatMessage(messages.betawarning)}
            </p>
            <p className="mt-3 text-sm leading-5 md:mt-0 md:ml-6">
              <a
                href="https://github.com/bitr8/agregarr-dev"
                className="whitespace-nowrap font-medium text-gray-100 transition duration-150 ease-in-out hover:text-white"
                target="_blank"
                rel="noreferrer"
              >
                GitHub &rarr;
              </a>
            </p>
          </div>
        </div>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.agregarrinformation)}>
          {data.version.startsWith('develop-') && (
            <Alert
              title={intl.formatMessage(messages.runningDevelop, {
                code: (msg: React.ReactNode) => (
                  <code className="bg-opacity-50">{msg}</code>
                ),
              })}
            />
          )}
          <List.Item
            title={intl.formatMessage(messages.version)}
            className="flex flex-row items-center truncate"
          >
            <code className="truncate">
              {data.version.replace(/^develop-(.{7}).*/, '$1')}
            </code>
            {status?.commitTag !== 'local' &&
              (status?.updateAvailable ? (
                <a
                  href={
                    data.version.startsWith('develop-')
                      ? `https://github.com/bitr8/agregarr-dev/compare/${status.commitTag}...develop`
                      : 'https://github.com/bitr8/agregarr-dev/commits/develop'
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Badge
                    badgeType="warning"
                    className="ml-2 !cursor-pointer transition hover:bg-orange-400"
                  >
                    {intl.formatMessage(messages.outofdate)}
                  </Badge>
                </a>
              ) : (
                <a
                  href="https://github.com/bitr8/agregarr-dev/commits/develop"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Badge
                    badgeType="success"
                    className="ml-2 !cursor-pointer transition hover:bg-green-400"
                  >
                    {intl.formatMessage(messages.uptodate)}
                  </Badge>
                </a>
              ))}
          </List.Item>
          <List.Item title={intl.formatMessage(messages.appDataPath)}>
            <code>{data.appDataPath}</code>
          </List.Item>
          {data.tz && (
            <List.Item title={intl.formatMessage(messages.timezone)}>
              <code>{data.tz}</code>
            </List.Item>
          )}
        </List>
      </div>
      <div className="section">
        <List title={intl.formatMessage(messages.gettingsupport)}>
          <List.Item title={intl.formatMessage(messages.githubissues)}>
            <a
              href="https://github.com/bitr8/agregarr-dev/issues"
              target="_blank"
              rel="noreferrer"
              className="text-orange-500 transition duration-300 hover:underline"
            >
              https://github.com/bitr8/agregarr-dev/issues
            </a>
          </List.Item>
          <List.Item title={intl.formatMessage(messages.agregarrdocs)}>
            <a
              href="https://agregarr.org"
              target="_blank"
              rel="noreferrer"
              className="text-orange-500 transition duration-300 hover:underline"
            >
              https://agregarr.org
            </a>
          </List.Item>
          <List.Item title={intl.formatMessage(messages.exportdebug)}>
            <Button
              buttonType="primary"
              onClick={() => setShowExportModal(true)}
            >
              <ArrowDownTrayIcon className="mr-2 h-5 w-5" />
              {intl.formatMessage(messages.exportDebugInfo)}
            </Button>
          </List.Item>
        </List>
      </div>
      {health && health.status !== 'disabled' && (
        <div className="section">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="heading">Health Checks</h3>
            <div className="flex items-center space-x-3">
              {health.checkedAt && (
                <span className="text-xs text-gray-400">
                  Last checked{' '}
                  {(() => {
                    const seconds = Math.floor(
                      (new Date(health.checkedAt).getTime() - Date.now()) / 1000
                    );
                    const minutes = Math.floor(seconds / 60);
                    if (Math.abs(minutes) < 60) {
                      return (
                        <FormattedRelativeTime
                          value={minutes}
                          unit="minute"
                          numeric="auto"
                          updateIntervalInSeconds={30}
                        />
                      );
                    }
                    return (
                      <FormattedRelativeTime
                        value={Math.floor(seconds / 3600)}
                        unit="hour"
                        numeric="auto"
                        updateIntervalInSeconds={300}
                      />
                    );
                  })()}
                </span>
              )}
              <Button
                buttonType="primary"
                onClick={async () => {
                  await axios.post('/api/v1/settings/jobs/health-checks/run');
                  addToast('Health checks started.', {
                    appearance: 'success',
                    autoDismiss: true,
                  });
                  setTimeout(() => revalidateHealth(), 3000);
                }}
              >
                <ArrowPathIcon className="mr-1 h-4 w-4" />
                Run Now
              </Button>
            </div>
          </div>
          {health.status === 'unknown' ? (
            <p className="text-sm text-gray-400">
              Health checks have not run yet. They will run automatically every
              6 hours, or click Run Now.
            </p>
          ) : (
            <div className="space-y-2">
              {health.checks.map((check) => (
                <div
                  key={check.id}
                  className={`flex items-start rounded-lg border border-gray-700 p-3 ${
                    check.silenced ? 'opacity-50' : ''
                  }`}
                >
                  <div className="mr-3 mt-0.5 flex-shrink-0">
                    {check.silenced ? (
                      <SpeakerXMarkIcon className="h-5 w-5 text-gray-500" />
                    ) : (
                      statusIcon(check.status)
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-white">
                        {check.name}
                      </span>
                      <div className="flex items-center space-x-2">
                        <Button
                          buttonType="ghost"
                          buttonSize="sm"
                          onClick={async () => {
                            if (check.silenced) {
                              await axios.delete(
                                `/api/v1/status/health/${check.id}/silence`
                              );
                            } else {
                              await axios.post(
                                `/api/v1/status/health/${check.id}/silence`
                              );
                            }
                            revalidateHealth();
                          }}
                        >
                          {check.silenced ? (
                            <>
                              <SpeakerWaveIcon className="mr-1 h-3.5 w-3.5" />
                              Unmute
                            </>
                          ) : (
                            <>
                              <SpeakerXMarkIcon className="mr-1 h-3.5 w-3.5" />
                              Mute
                            </>
                          )}
                        </Button>
                      </div>
                    </div>
                    {check.message && (
                      <p className="mt-1 text-xs text-gray-400">
                        {check.message}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <ExportDebugModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
      />
    </>
  );
};

export default SettingsAbout;
