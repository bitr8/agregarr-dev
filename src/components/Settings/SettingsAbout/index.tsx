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
  ArrowDownTrayIcon,
  InformationCircleIcon,
} from '@heroicons/react/24/solid';
import type {
  SettingsAboutResponse,
  StatusResponse,
} from '@server/interfaces/api/settingsInterfaces';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
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

const SettingsAbout = () => {
  const intl = useIntl();
  const [showExportModal, setShowExportModal] = useState(false);
  const { data, error } = useSWR<SettingsAboutResponse>(
    '/api/v1/settings/about'
  );

  const { data: status } = useSWR<StatusResponse>('/api/v1/status');

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
      <ExportDebugModal
        isOpen={showExportModal}
        onClose={() => setShowExportModal(false)}
      />
    </>
  );
};

export default SettingsAbout;
