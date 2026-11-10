import Button from '@app/components/Common/Button';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import type { TracearrSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Formik } from 'formik';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR from 'swr';
import * as Yup from 'yup';

const messages = defineMessages({
  tracearrSettings: 'Tracearr Settings',
  tracearrSettingsDescription:
    'Optionally use Tracearr instead of Tautulli as the source of watch statistics. Statistics collections and the dashboard use it while enabled. Tracearr reports at most the last 365 days.',
  tracearrEnabled: 'Use Tracearr for statistics',
  tracearrHostname: 'Hostname or IP Address',
  tracearrPort: 'Port',
  tracearrUseSsl: 'Use SSL',
  tracearrUrlBase: 'URL Base',
  tracearrApiKey: 'API Key',
  tracearrServer: 'Server',
  tracearrAllServers: 'All servers',
  tracearrServerHelp:
    'Run the connection test to load your servers. Leave on all servers to count plays from every server Tracearr tracks.',
  tracearrTestConnection: 'Test Connection',
  testing: 'Testing...',
  save: 'Save Changes',
  saving: 'Saving…',
  tracearrToastSuccess: 'Tracearr settings saved successfully!',
  tracearrToastFailure: 'Something went wrong while saving Tracearr settings.',
  tracearrConnectionSuccess: 'Connected to Tracearr successfully!',
  tracearrConnectionFailure: 'Failed to connect to Tracearr',
  tracearrValidationHostname: 'You must provide a valid hostname or IP address',
  tracearrValidationPort: 'You must provide a valid port number',
  validationUrlBaseLeadingSlash: 'URL base must have a leading slash',
  validationUrlBaseTrailingSlash: 'URL base must not end in a trailing slash',
});

interface TracearrServerOption {
  server_id: string;
  server_name: string;
  server_type: string;
}

const TracearrSettingsForm = () => {
  const intl = useIntl();
  const { addToast } = useToasts();
  const { data, mutate } = useSWR<TracearrSettings>(
    '/api/v1/settings/tracearr'
  );
  const [isTesting, setIsTesting] = useState(false);
  const [servers, setServers] = useState<TracearrServerOption[]>([]);

  const schema = Yup.object().shape({
    hostname: Yup.string()
      .nullable()
      .matches(
        /^[^\s/:@]+$/,
        intl.formatMessage(messages.tracearrValidationHostname)
      ),
    port: Yup.number()
      .typeError(intl.formatMessage(messages.tracearrValidationPort))
      .nullable(),
    urlBase: Yup.string()
      .test(
        'leading-slash',
        intl.formatMessage(messages.validationUrlBaseLeadingSlash),
        (value) => !value || value.startsWith('/')
      )
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationUrlBaseTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  return (
    <>
      <div className="section">
        <div className="mb-6 mt-10">
          <h3 className="heading flex items-center">
            {intl.formatMessage(messages.tracearrSettings)}
          </h3>
          <p className="description">
            {intl.formatMessage(messages.tracearrSettingsDescription)}
          </p>
        </div>
      </div>
      <Formik
        initialValues={{
          enabled: data?.enabled ?? false,
          hostname: data?.hostname,
          port: data?.port ?? 3000,
          useSsl: data?.useSsl ?? false,
          urlBase: data?.urlBase,
          apiKey: data?.apiKey,
          serverId: data?.serverId ?? '',
        }}
        validationSchema={schema}
        enableReinitialize
        onSubmit={async (values) => {
          try {
            await axios.post('/api/v1/settings/tracearr', {
              ...values,
              port: Number(values.port),
            });
            addToast(intl.formatMessage(messages.tracearrToastSuccess), {
              appearance: 'success',
              autoDismiss: true,
            });
          } catch (e) {
            addToast(intl.formatMessage(messages.tracearrToastFailure), {
              appearance: 'error',
              autoDismiss: true,
            });
          } finally {
            mutate();
          }
        }}
      >
        {({
          errors,
          touched,
          handleSubmit,
          setFieldValue,
          isSubmitting,
          isValid,
          values,
        }) => {
          const testConnection = async () => {
            setIsTesting(true);
            try {
              const response = await axios.post(
                '/api/v1/settings/tracearr/test',
                {
                  hostname: values.hostname,
                  port: Number(values.port),
                  apiKey: values.apiKey,
                  useSsl: values.useSsl,
                  urlBase: values.urlBase,
                }
              );
              setServers(response.data.servers ?? []);
              addToast(intl.formatMessage(messages.tracearrConnectionSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch (error) {
              addToast(
                error.response?.data?.message ||
                  intl.formatMessage(messages.tracearrConnectionFailure),
                { autoDismiss: true, appearance: 'error' }
              );
            } finally {
              setIsTesting(false);
            }
          };

          const knownServer = servers.some(
            (server) => server.server_id === values.serverId
          );

          return (
            <form className="section" onSubmit={handleSubmit}>
              <div className="form-row">
                <label htmlFor="tracearrEnabled" className="checkbox-label">
                  {intl.formatMessage(messages.tracearrEnabled)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="tracearrEnabled"
                    name="enabled"
                    onChange={() => setFieldValue('enabled', !values.enabled)}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrHostname" className="text-label">
                  {intl.formatMessage(messages.tracearrHostname)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <span className="inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-stone-800 px-3 text-gray-100 sm:text-sm">
                      {values.useSsl ? 'https://' : 'http://'}
                    </span>
                    <Field
                      type="text"
                      inputMode="url"
                      id="tracearrHostname"
                      name="hostname"
                      className="rounded-r-only flex-1"
                    />
                  </div>
                  {errors.hostname && touched.hostname && (
                    <div className="error">{errors.hostname}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrPort" className="text-label">
                  {intl.formatMessage(messages.tracearrPort)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <Field
                    type="text"
                    inputMode="numeric"
                    id="tracearrPort"
                    name="port"
                    className="short"
                  />
                  {errors.port && touched.port && (
                    <div className="error">{errors.port}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrUseSsl" className="checkbox-label">
                  {intl.formatMessage(messages.tracearrUseSsl)}
                </label>
                <div className="form-input-area">
                  <Field
                    type="checkbox"
                    id="tracearrUseSsl"
                    name="useSsl"
                    onChange={() => setFieldValue('useSsl', !values.useSsl)}
                  />
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrUrlBase" className="text-label">
                  {intl.formatMessage(messages.tracearrUrlBase)}
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <Field
                      type="text"
                      inputMode="url"
                      id="tracearrUrlBase"
                      name="urlBase"
                      autoComplete="off"
                      data-1pignore="true"
                      data-lpignore="true"
                      data-bwignore="true"
                    />
                  </div>
                  {errors.urlBase && touched.urlBase && (
                    <div className="error">{errors.urlBase}</div>
                  )}
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrApiKey" className="text-label">
                  {intl.formatMessage(messages.tracearrApiKey)}
                  <span className="label-required">*</span>
                </label>
                <div className="form-input-area">
                  <div className="form-input-field">
                    <SensitiveInput
                      as="field"
                      id="tracearrApiKey"
                      name="apiKey"
                    />
                  </div>
                </div>
              </div>
              <div className="form-row">
                <label htmlFor="tracearrServer" className="text-label">
                  {intl.formatMessage(messages.tracearrServer)}
                  <span className="label-tip">
                    {intl.formatMessage(messages.tracearrServerHelp)}
                  </span>
                </label>
                <div className="form-input-area">
                  <Field as="select" id="tracearrServer" name="serverId">
                    <option value="">
                      {intl.formatMessage(messages.tracearrAllServers)}
                    </option>
                    {values.serverId && !knownServer && (
                      <option value={values.serverId}>{values.serverId}</option>
                    )}
                    {servers.map((server) => (
                      <option key={server.server_id} value={server.server_id}>
                        {`${server.server_name} (${server.server_type})`}
                      </option>
                    ))}
                  </Field>
                </div>
              </div>
              <div className="actions">
                <div className="flex justify-end">
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="default"
                      type="button"
                      onClick={testConnection}
                      disabled={
                        !values.hostname ||
                        !values.port ||
                        !values.apiKey ||
                        isTesting
                      }
                    >
                      {isTesting
                        ? intl.formatMessage(messages.testing)
                        : intl.formatMessage(messages.tracearrTestConnection)}
                    </Button>
                  </span>
                  <span className="ml-3 inline-flex rounded-md shadow-sm">
                    <Button
                      buttonType="primary"
                      type="submit"
                      disabled={isSubmitting || !isValid}
                    >
                      <ArrowDownOnSquareIcon />
                      <span>
                        {isSubmitting
                          ? intl.formatMessage(messages.saving)
                          : intl.formatMessage(messages.save)}
                      </span>
                    </Button>
                  </span>
                </div>
              </div>
            </form>
          );
        }}
      </Formik>
    </>
  );
};

export default TracearrSettingsForm;
