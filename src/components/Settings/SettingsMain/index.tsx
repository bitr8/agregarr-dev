import Button from '@app/components/Common/Button';
import ConfirmButton from '@app/components/Common/ConfirmButton';
import LoadingSpinner from '@app/components/Common/LoadingSpinner';
import PageTitle from '@app/components/Common/PageTitle';
import SensitiveInput from '@app/components/Common/SensitiveInput';
import Tooltip from '@app/components/Common/Tooltip';
import CopyButton from '@app/components/Settings/CopyButton';
import SettingsBadge from '@app/components/Settings/SettingsBadge';
import type { AvailableLocale } from '@app/context/LanguageContext';
import { availableLanguages } from '@app/context/LanguageContext';
import useLocale from '@app/hooks/useLocale';
import { Permission, useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import { ArrowDownOnSquareIcon } from '@heroicons/react/24/outline';
import { ArrowPathIcon } from '@heroicons/react/24/solid';
// UserSettingsGeneralResponse removed - user settings functionality simplified
import { TMDB_LANGUAGES } from '@app/utils/tmdbConstants';
import type { MainSettings } from '@server/lib/settings';
import axios from 'axios';
import { Field, Form, Formik } from 'formik';
import { useState } from 'react';
import { defineMessages, useIntl } from 'react-intl';
import { useToasts } from 'react-toast-notifications';
import useSWR, { mutate } from 'swr';
import * as Yup from 'yup';

const messages = defineMessages({
  general: 'General',
  generalsettings: 'General Settings',
  generalsettingsDescription:
    'Configure global and default settings for Agregarr.',
  apikey: 'API Key',
  applicationTitle: 'Application Title',
  applicationurl: 'Application URL',
  toastApiKeySuccess: 'New API key generated successfully!',
  toastApiKeyFailure: 'Something went wrong while generating a new API key.',
  toastSettingsSuccess: 'Settings saved successfully!',
  toastSettingsFailure: 'Something went wrong while saving settings.',
  csrfProtection: 'Enable CSRF Protection',
  csrfProtectionTip: 'Set external API access to read-only (requires HTTPS)',
  csrfProtectionHoverTip:
    'Do NOT enable this setting unless you understand what you are doing!',
  trustProxy: 'Enable Proxy Support',
  trustProxyTip:
    'Allow Agregarr to correctly register client IP addresses behind a proxy',
  validationApplicationTitle: 'You must provide an application title',
  validationApplicationUrl: 'You must provide a valid URL',
  validationApplicationUrlTrailingSlash: 'URL must not end in a trailing slash',
  locale: 'Display Language',
  tmdbLanguage: 'TMDB Language',
  tmdbLanguageTip: 'Language for TMDB posters',
  watchProviderRegion: 'Watch Provider Region',
  watchProviderRegionTip:
    'Region used by the Streaming Provider overlay to determine available services',
  overlayConcurrency: 'Parallel Items',
  overlayConcurrencyTip:
    'Number of items to process simultaneously during overlay application. Higher values are faster but use more memory.',
  enableTmdbPosterCache: 'Enable TMDB Poster Cache',
  enableTmdbPosterCacheTip:
    'Cache TMDB posters for 7 days to reduce API calls and improve performance (recommended)',
  enableHealthChecks: 'Enable Health Checks',
  enableHealthChecksTip:
    'Run periodic health checks to detect connection issues and configuration problems',
  excludeFromOrderingLabel: 'Exclude from Ordering (Plex Label)',
  excludeFromOrderingLabelTip:
    'Collections with this Plex label will be excluded from ordering, visibility, and sort title enforcement. Useful when other tools (Shortlist, Kometa) manage their own collections.',
  logLevel: 'Log Level',
  logLevelTip: 'Controls how much detail appears in logs',
  resetAgregarr: 'Reset',
  resetAgregarrDescription:
    'Remove all Agregarr collections from Plex and clear all user labels.',
  resetButton: 'Reset Collections',
  resetButtonConfirm: 'Are you sure?',
  resetWarning:
    'This action will delete all collections created by Agregarr from your Plex server and clear all Agregarr user labels.',
  resetting: 'Resetting...',
  toastResetSuccess: 'All Agregarr collections have been removed successfully!',
  toastResetFailure: 'Something went wrong while resetting collections.',
});

interface TmdbCountry {
  iso_3166_1: string;
  english_name: string;
}

const SettingsMain = () => {
  const { addToast } = useToasts();
  const { hasPermission: userHasPermission } = useUser();
  const intl = useIntl();
  const { setLocale } = useLocale();
  const [isResetting, setIsResetting] = useState(false);
  const {
    data,
    error,
    mutate: revalidate,
  } = useSWR<
    MainSettings & { watchProviderRegion?: string; overlayConcurrency?: number }
  >('/api/v1/settings/main');
  const { data: countriesData } = useSWR<TmdbCountry[]>('/api/v1/countries');

  const MainSettingsSchema = Yup.object().shape({
    applicationTitle: Yup.string().required(
      intl.formatMessage(messages.validationApplicationTitle)
    ),
    applicationUrl: Yup.string()
      .url(intl.formatMessage(messages.validationApplicationUrl))
      .test(
        'no-trailing-slash',
        intl.formatMessage(messages.validationApplicationUrlTrailingSlash),
        (value) => !value || !value.endsWith('/')
      ),
  });

  const regenerate = async () => {
    try {
      await axios.post('/api/v1/settings/main/regenerate');

      revalidate();
      addToast(intl.formatMessage(messages.toastApiKeySuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch (e) {
      addToast(intl.formatMessage(messages.toastApiKeyFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    }
  };

  const handleReset = async () => {
    setIsResetting(true);
    try {
      await axios.post('/api/v1/settings/reset');

      addToast(intl.formatMessage(messages.toastResetSuccess), {
        autoDismiss: true,
        appearance: 'success',
      });
    } catch (e) {
      addToast(intl.formatMessage(messages.toastResetFailure), {
        autoDismiss: true,
        appearance: 'error',
      });
    } finally {
      setIsResetting(false);
    }
  };

  if (!data && !error) {
    return <LoadingSpinner />;
  }

  return (
    <>
      <PageTitle
        title={[
          intl.formatMessage(messages.general),
          intl.formatMessage(globalMessages.settings),
        ]}
      />
      <div className="mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.generalsettings)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.generalsettingsDescription)}
        </p>
      </div>
      <div className="section">
        <Formik
          initialValues={{
            applicationTitle: data?.applicationTitle,
            applicationUrl: data?.applicationUrl,
            csrfProtection: data?.csrfProtection,
            locale: data?.locale ?? 'en',
            tmdbLanguage: data?.tmdbLanguage ?? 'en',
            enableTmdbPosterCache: data?.enableTmdbPosterCache ?? true,
            healthChecksEnabled: data?.healthChecksEnabled ?? true,
            excludeFromOrderingLabel: data?.excludeFromOrderingLabel ?? '',
            watchProviderRegion: data?.watchProviderRegion ?? 'US',
            overlayConcurrency: data?.overlayConcurrency ?? 1,
            trustProxy: data?.trustProxy,
            logLevel: data?.logLevel ?? 'info',
          }}
          enableReinitialize
          validationSchema={MainSettingsSchema}
          onSubmit={async (values) => {
            try {
              await axios.post('/api/v1/settings/main', {
                applicationTitle: values.applicationTitle,
                applicationUrl: values.applicationUrl,
                csrfProtection: values.csrfProtection,
                locale: values.locale,
                tmdbLanguage: values.tmdbLanguage,
                enableTmdbPosterCache: values.enableTmdbPosterCache,
                healthChecksEnabled: values.healthChecksEnabled,
                excludeFromOrderingLabel:
                  values.excludeFromOrderingLabel || undefined,
                watchProviderRegion: values.watchProviderRegion,
                overlayConcurrency: values.overlayConcurrency,
                trustProxy: values.trustProxy,
                logLevel: values.logLevel,
              });
              mutate('/api/v1/settings/public');
              mutate('/api/v1/status');

              if (setLocale) {
                setLocale(values.locale as AvailableLocale);
              }

              addToast(intl.formatMessage(messages.toastSettingsSuccess), {
                autoDismiss: true,
                appearance: 'success',
              });
            } catch (e) {
              addToast(intl.formatMessage(messages.toastSettingsFailure), {
                autoDismiss: true,
                appearance: 'error',
              });
            } finally {
              revalidate();
            }
          }}
        >
          {({
            errors,
            touched,
            isSubmitting,
            isValid,
            values,
            setFieldValue,
          }) => {
            return (
              <Form className="section" data-testid="settings-main-form">
                {userHasPermission(Permission.ADMIN) && (
                  <div className="form-row">
                    <label htmlFor="apiKey" className="text-label">
                      {intl.formatMessage(messages.apikey)}
                    </label>
                    <div className="form-input-area">
                      <div className="form-input-field">
                        <SensitiveInput
                          type="text"
                          id="apiKey"
                          className="rounded-l-only"
                          value={data?.apiKey}
                          readOnly
                        />
                        <CopyButton
                          textToCopy={data?.apiKey ?? ''}
                          key={data?.apiKey}
                        />
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            regenerate();
                          }}
                          className="input-action"
                        >
                          <ArrowPathIcon />
                        </button>
                      </div>
                    </div>
                  </div>
                )}
                <div className="form-row">
                  <label htmlFor="applicationTitle" className="text-label">
                    {intl.formatMessage(messages.applicationTitle)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="applicationTitle"
                        name="applicationTitle"
                        type="text"
                      />
                    </div>
                    {errors.applicationTitle &&
                      touched.applicationTitle &&
                      typeof errors.applicationTitle === 'string' && (
                        <div className="error">{errors.applicationTitle}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="applicationUrl" className="text-label">
                    {intl.formatMessage(messages.applicationurl)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="applicationUrl"
                        name="applicationUrl"
                        type="text"
                        inputMode="url"
                      />
                    </div>
                    {errors.applicationUrl &&
                      touched.applicationUrl &&
                      typeof errors.applicationUrl === 'string' && (
                        <div className="error">{errors.applicationUrl}</div>
                      )}
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="locale" className="text-label">
                    {intl.formatMessage(messages.locale)}
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="locale" name="locale">
                        {(
                          Object.keys(
                            availableLanguages
                          ) as (keyof typeof availableLanguages)[]
                        ).map((key) => (
                          <option
                            key={key}
                            value={availableLanguages[key].code}
                            lang={availableLanguages[key].code}
                          >
                            {availableLanguages[key].display}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="tmdbLanguage" className="text-label">
                    {intl.formatMessage(messages.tmdbLanguage)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.tmdbLanguageTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="tmdbLanguage" name="tmdbLanguage">
                        {TMDB_LANGUAGES.map((lang) => (
                          <option key={lang.code} value={lang.code}>
                            {lang.name}
                          </option>
                        ))}
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="watchProviderRegion" className="text-label">
                    {intl.formatMessage(messages.watchProviderRegion)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.watchProviderRegionTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        as="select"
                        id="watchProviderRegion"
                        name="watchProviderRegion"
                        disabled={!countriesData}
                      >
                        {!countriesData && (
                          <option value={values.watchProviderRegion}>
                            Loading...
                          </option>
                        )}
                        {countriesData
                          ?.slice()
                          .sort((a, b) =>
                            a.english_name.localeCompare(b.english_name)
                          )
                          .map((country) => (
                            <option
                              key={country.iso_3166_1}
                              value={country.iso_3166_1}
                            >
                              {country.english_name}
                            </option>
                          ))}
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="overlayConcurrency" className="text-label">
                    {intl.formatMessage(messages.overlayConcurrency)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.overlayConcurrencyTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        type="number"
                        id="overlayConcurrency"
                        name="overlayConcurrency"
                        min="1"
                        max="10"
                        className="short"
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                          const val = Number(e.target.value);
                          if (Number.isFinite(val)) {
                            setFieldValue(
                              'overlayConcurrency',
                              Math.max(1, Math.min(10, Math.floor(val)))
                            );
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="enableTmdbPosterCache"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.enableTmdbPosterCache)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.enableTmdbPosterCacheTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="enableTmdbPosterCache"
                      name="enableTmdbPosterCache"
                      onChange={() => {
                        setFieldValue(
                          'enableTmdbPosterCache',
                          !values.enableTmdbPosterCache
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="healthChecksEnabled"
                    className="checkbox-label"
                  >
                    <span className="mr-2">
                      {intl.formatMessage(messages.enableHealthChecks)}
                    </span>
                    <span className="label-tip">
                      {intl.formatMessage(messages.enableHealthChecksTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="healthChecksEnabled"
                      name="healthChecksEnabled"
                      onChange={() => {
                        setFieldValue(
                          'healthChecksEnabled',
                          !values.healthChecksEnabled
                        );
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label
                    htmlFor="excludeFromOrderingLabel"
                    className="text-label"
                  >
                    {intl.formatMessage(messages.excludeFromOrderingLabel)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.excludeFromOrderingLabelTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field
                        id="excludeFromOrderingLabel"
                        name="excludeFromOrderingLabel"
                        type="text"
                        placeholder="e.g. shortlist"
                      />
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="logLevel" className="text-label">
                    {intl.formatMessage(messages.logLevel)}
                    <span className="label-tip">
                      {intl.formatMessage(messages.logLevelTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <div className="form-input-field">
                      <Field as="select" id="logLevel" name="logLevel">
                        <option value="error">Error</option>
                        <option value="warn">Warning</option>
                        <option value="info">Info</option>
                        <option value="debug">Debug</option>
                      </Field>
                    </div>
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="trustProxy" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.trustProxy)}
                    </span>
                    <SettingsBadge badgeType="restartRequired" />
                    <span className="label-tip">
                      {intl.formatMessage(messages.trustProxyTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Field
                      type="checkbox"
                      id="trustProxy"
                      name="trustProxy"
                      onChange={() => {
                        setFieldValue('trustProxy', !values.trustProxy);
                      }}
                    />
                  </div>
                </div>
                <div className="form-row">
                  <label htmlFor="csrfProtection" className="checkbox-label">
                    <span className="mr-2">
                      {intl.formatMessage(messages.csrfProtection)}
                    </span>
                    <SettingsBadge badgeType="advanced" className="mr-2" />
                    <SettingsBadge badgeType="restartRequired" />
                    <span className="label-tip">
                      {intl.formatMessage(messages.csrfProtectionTip)}
                    </span>
                  </label>
                  <div className="form-input-area">
                    <Tooltip
                      content={intl.formatMessage(
                        messages.csrfProtectionHoverTip
                      )}
                    >
                      <Field
                        type="checkbox"
                        id="csrfProtection"
                        name="csrfProtection"
                        onChange={() => {
                          setFieldValue(
                            'csrfProtection',
                            !values.csrfProtection
                          );
                        }}
                      />
                    </Tooltip>
                  </div>
                </div>
                <div className="actions">
                  <div className="flex justify-end">
                    <span className="ml-3 inline-flex rounded-md shadow-sm">
                      <Button
                        buttonType="primary"
                        type="submit"
                        disabled={isSubmitting || !isValid}
                      >
                        <ArrowDownOnSquareIcon />
                        <span>
                          {isSubmitting
                            ? intl.formatMessage(globalMessages.saving)
                            : intl.formatMessage(globalMessages.save)}
                        </span>
                      </Button>
                    </span>
                  </div>
                </div>
              </Form>
            );
          }}
        </Formik>
      </div>

      {/* Reset Section */}
      <div className="mt-8 mb-6">
        <h3 className="heading">
          {intl.formatMessage(messages.resetAgregarr)}
        </h3>
        <p className="description">
          {intl.formatMessage(messages.resetAgregarrDescription)}
        </p>
      </div>
      <div className="section">
        <div className="rounded-md border border-yellow-500 bg-yellow-500 bg-opacity-10 p-4">
          <p className="text-sm text-yellow-200">
            {intl.formatMessage(messages.resetWarning)}
          </p>
        </div>
        <div className="mt-4 flex justify-end">
          <ConfirmButton
            onClick={handleReset}
            confirmText={intl.formatMessage(messages.resetButtonConfirm)}
            buttonType="danger"
            className="relative"
          >
            <span>
              {isResetting
                ? intl.formatMessage(messages.resetting)
                : intl.formatMessage(messages.resetButton)}
            </span>
          </ConfirmButton>
        </div>
      </div>
    </>
  );
};

export default SettingsMain;
