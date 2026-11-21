import { useTemplatePreview } from '@app/hooks/useTemplatePreview';
import type {
  CollectionFormConfig,
  Library,
  TemplatePreset,
} from '@app/types/collections';
import { resolveTemplateFix } from '@app/utils/collections/collectionFormRules';
import { Field, type FormikErrors, type FormikTouched } from 'formik';
import type React from 'react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { defineMessages, useIntl } from 'react-intl';

const messages = defineMessages({
  previewUnavailable: 'Preview unavailable',
  preview: 'Preview:',
});

interface FetchedTitles {
  [key: string]: string;
}

interface DetectedMediaTypes {
  [key: string]: 'movie' | 'tv' | 'both' | 'mixed' | null;
}

interface TemplateSectionProps {
  values: CollectionFormConfig;
  setFieldValue: (
    field: string,
    value: string | number | boolean | string[] | object | null
  ) => void;
  handleChange: (
    e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>
  ) => void;
  errors: FormikErrors<CollectionFormConfig>;
  touched: FormikTouched<CollectionFormConfig>;
  fetchedTitles: FetchedTitles;
  detectedMediaTypes: DetectedMediaTypes;
  getTemplatePresets: (
    values: CollectionFormConfig,
    fetchedTitles: FetchedTitles,
    detectedMediaTypes: DetectedMediaTypes
  ) => TemplatePreset[];
  isVisible?: boolean;
  isEditing?: boolean;
  currentUser?: {
    id: number;
    displayName: string;
    email: string;
    plexUsername: string;
  };
  libraries?: Library[];
}

// Memoized template preview component to prevent unnecessary re-renders
const TemplatePreviewItem = memo(function TemplatePreviewItem({
  template,
  mediaType,
  type,
  subtype,
  customDays,
}: {
  template: string;
  mediaType: 'movie' | 'tv';
  type?: string;
  subtype?: string;
  customDays?: number;
}) {
  const intl = useIntl();
  const { preview, loading, error } = useTemplatePreview({
    template,
    mediaType,
    type,
    subtype,
    customDays,
  });

  if (loading) return <span className="text-gray-400">Loading...</span>;
  if (error)
    return (
      <span className="text-gray-500">
        {intl.formatMessage(messages.previewUnavailable)}
      </span>
    );

  return (
    <span className="text-gray-300">
      {preview || 'Preview will appear here...'}
    </span>
  );
});

const TemplateSection = ({
  values,
  setFieldValue,
  handleChange,
  errors,
  touched,
  fetchedTitles,
  detectedMediaTypes,
  getTemplatePresets,
  isVisible = true,
  isEditing = false,
  libraries = [],
}: TemplateSectionProps) => {
  const intl = useIntl();
  // Memoize the template-relevant values to prevent unnecessary API calls
  const templateRelevantValues = useMemo(() => {
    const effectiveSubtype =
      values.type === 'trakt' &&
      values.timePeriod &&
      ['played', 'watched', 'collected', 'favorited'].includes(
        values.subtype || ''
      )
        ? `${values.subtype}_${values.timePeriod}`
        : values.subtype;

    return {
      type: values.type,
      subtype: effectiveSubtype,
      customDays: values.customDays
        ? parseInt(values.customDays.toString(), 10)
        : undefined,
    };
  }, [values.type, values.subtype, values.timePeriod, values.customDays]);

  const presetValues = getTemplatePresets(
    values,
    fetchedTitles,
    detectedMediaTypes
  )
    .map((p) => p.value)
    .join('\u0000');

  const editConversionPending = useRef(isEditing);
  const initialSource = useRef(`${values.type}/${values.subtype}`);

  useEffect(() => {
    if (!isVisible) return;
    const selected = libraries.filter(
      (lib) => values.libraryIds?.includes(lib.key) ?? false
    );
    const { fix, settled } = resolveTemplateFix({
      template: values.template,
      presetValues: presetValues ? presetValues.split('\u0000') : [],
      hasMovieLib: selected.some((lib) => lib.type === 'movie'),
      hasTVLib: selected.some((lib) => lib.type === 'show'),
      pendingEditConversion: editConversionPending.current,
      sourceChanged:
        initialSource.current !== `${values.type}/${values.subtype}`,
    });
    if (settled) editConversionPending.current = false;
    if (!fix) return;
    setFieldValue('template', fix.template);
    if (fix.customMovieTemplate !== undefined)
      setFieldValue('customMovieTemplate', fix.customMovieTemplate);
    if (fix.customTVTemplate !== undefined)
      setFieldValue('customTVTemplate', fix.customTVTemplate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible, values.template, presetValues]);

  if (!isVisible) return null;

  return (
    <>
      <div className="form-input-field">
        <Field
          as="select"
          id="collectionTemplate"
          name="template"
          value={values.template}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => {
            handleChange(e);
            if (e.target.value !== 'custom') {
              // Clear custom templates when selecting a preset
              setFieldValue('customMovieTemplate', '');
              setFieldValue('customTVTemplate', '');
            }
            if (
              e.target.value !== 'DYNAMIC_RANDOM_TITLE' &&
              e.target.value !== 'DYNAMIC_CYCLE_TITLE'
            ) {
              // Clear dynamic title prefix when not using dynamic titles
              setFieldValue('dynamicTitlePrefix', '');
            }
          }}
        >
          {(() => {
            const templatePresets = getTemplatePresets(
              values,
              fetchedTitles,
              detectedMediaTypes
            );

            return templatePresets.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ));
          })()}
        </Field>
      </div>

      {/* Dynamic title prefix input */}
      {(values.template === 'DYNAMIC_RANDOM_TITLE' ||
        values.template === 'DYNAMIC_CYCLE_TITLE') && (
        <div className="mt-2">
          <div className="form-input-field">
            <Field
              type="text"
              name="dynamicTitlePrefix"
              placeholder="Title prefix (e.g. 🎬)"
              onChange={handleChange}
            />
          </div>
          <div className="label-tip">
            This text will be prepended to the dynamic title. Example: if prefix
            is &quot;🎬&quot; and the list title is &quot;Musical&quot;, the
            collection will be named &quot;🎬 Musical&quot;.
          </div>
        </div>
      )}

      {/* Custom template input */}
      {values.template === 'custom' && (
        <div className="mt-2 space-y-3">
          {(() => {
            // Check if user has selected both movie AND TV libraries
            if (!values.libraryIds || !Array.isArray(values.libraryIds)) {
              return null;
            }
            const selectedLibraries = libraries.filter(
              (lib) => values.libraryIds?.includes(lib.key) ?? false
            );
            const hasMovieLib = selectedLibraries.some(
              (lib) => lib.type === 'movie'
            );
            const hasTVLib = selectedLibraries.some(
              (lib) => lib.type === 'show'
            );

            if (hasMovieLib && hasTVLib) {
              // Both movie and TV libraries selected - show separate templates
              return (
                <>
                  {/* Separate movie template */}
                  <div className="form-input-field">
                    <Field
                      type="text"
                      name="customMovieTemplate"
                      placeholder="Movie collection template"
                      onChange={handleChange}
                    />
                    {errors.customMovieTemplate &&
                      touched.customMovieTemplate && (
                        <div className="error">
                          {errors.customMovieTemplate}
                        </div>
                      )}
                  </div>
                  {/* Separate TV template */}
                  <div className="form-input-field">
                    <Field
                      type="text"
                      name="customTVTemplate"
                      placeholder="TV show collection template"
                      onChange={handleChange}
                    />
                    {errors.customTVTemplate && touched.customTVTemplate && (
                      <div className="error">{errors.customTVTemplate}</div>
                    )}
                  </div>
                </>
              );
            } else if (hasMovieLib) {
              // Only movie libraries selected - show movie template
              return (
                <div className="form-input-field">
                  <Field
                    type="text"
                    name="customMovieTemplate"
                    placeholder="Movie collection template"
                    onChange={handleChange}
                  />
                  {errors.customMovieTemplate &&
                    touched.customMovieTemplate && (
                      <div className="error">{errors.customMovieTemplate}</div>
                    )}
                </div>
              );
            } else if (hasTVLib) {
              // Only TV libraries selected - show TV template
              return (
                <div className="form-input-field">
                  <Field
                    type="text"
                    name="customTVTemplate"
                    placeholder="TV show collection template"
                    onChange={handleChange}
                  />
                  {errors.customTVTemplate && touched.customTVTemplate && (
                    <div className="error">{errors.customTVTemplate}</div>
                  )}
                </div>
              );
            }

            return null; // No libraries selected or compatible
          })()}
        </div>
      )}

      {/* Template preview */}
      <div className="mt-3 rounded-md border border-gray-600 bg-stone-800 p-3">
        <h5 className="mb-2 text-sm font-medium text-gray-200">
          {intl.formatMessage(messages.preview)}
        </h5>
        <div className="text-sm text-gray-300">
          {(() => {
            // Get the actual template being used (same logic as dropdown)
            const templatePresets = getTemplatePresets(
              values,
              fetchedTitles,
              detectedMediaTypes
            );
            const currentTemplate =
              values.template || templatePresets[0]?.value || '';

            const selectedLibraryIds =
              values.libraryIds ||
              (values.libraryId
                ? Array.isArray(values.libraryId)
                  ? values.libraryId
                  : [values.libraryId]
                : []);
            const hasAllLibraries =
              selectedLibraryIds.includes('all') || values.libraryId === 'all';
            const specificLibraryIds = selectedLibraryIds.filter(
              (id: string) => id !== 'all'
            );
            const hasMultipleSpecificLibraries = specificLibraryIds.length > 1;

            if (hasAllLibraries) {
              return (
                // Show preview for each library when "All Libraries" is selected
                <div className="space-y-2">
                  {libraries.map((library) => {
                    const libraryMediaType =
                      library.type === 'show' ? 'tv' : 'movie';
                    const templateToUse = (() => {
                      if (values.template === 'custom') {
                        if (libraryMediaType === 'movie') {
                          return values.customMovieTemplate || '';
                        } else {
                          return values.customTVTemplate || '';
                        }
                      }
                      return currentTemplate;
                    })();

                    return (
                      <div
                        key={library.key}
                        className="flex items-start space-x-2"
                      >
                        <span className="flex-shrink-0 font-medium text-orange-400">
                          {library.name}:
                        </span>
                        <TemplatePreviewItem
                          template={templateToUse}
                          mediaType={libraryMediaType}
                          type={templateRelevantValues.type}
                          subtype={templateRelevantValues.subtype}
                          customDays={templateRelevantValues.customDays}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            } else if (hasMultipleSpecificLibraries) {
              return (
                // Show preview for each selected specific library
                <div className="space-y-2">
                  {selectedLibraryIds
                    .filter((id) => id !== 'all')
                    .map((libraryId) => {
                      const library = libraries.find(
                        (lib) => lib.key === libraryId
                      );
                      if (!library) return null;

                      const libraryMediaType =
                        library.type === 'show' ? 'tv' : 'movie';
                      const templateToUse = (() => {
                        if (values.template === 'custom') {
                          if (libraryMediaType === 'movie') {
                            return values.customMovieTemplate || '';
                          } else {
                            return values.customTVTemplate || '';
                          }
                        }
                        return currentTemplate;
                      })();

                      return (
                        <div
                          key={library.key}
                          className="flex items-start space-x-2"
                        >
                          <span className="flex-shrink-0 font-medium text-orange-400">
                            {library.name}:
                          </span>
                          <TemplatePreviewItem
                            template={templateToUse}
                            mediaType={libraryMediaType}
                            type={templateRelevantValues.type}
                            subtype={templateRelevantValues.subtype}
                            customDays={templateRelevantValues.customDays}
                          />
                        </div>
                      );
                    })}
                </div>
              );
            } else {
              // Single library or no library selected - show simple preview
              const templateToUse = (() => {
                if (values.template === 'custom') {
                  if (values.mediaType === 'movie') {
                    return values.customMovieTemplate || '';
                  } else if (values.mediaType === 'tv') {
                    return values.customTVTemplate || '';
                  } else {
                    return (
                      values.customMovieTemplate ||
                      values.customTVTemplate ||
                      ''
                    );
                  }
                }
                return currentTemplate;
              })();

              // For single library, determine media type from the actual selected library
              const selectedLibraryId =
                selectedLibraryIds[0] || values.libraryId;
              const selectedLibrary = libraries.find(
                (lib) => lib.key === selectedLibraryId
              );
              const singleLibraryMediaType =
                selectedLibrary?.type === 'show' ? 'tv' : 'movie';

              return (
                <div>
                  <TemplatePreviewItem
                    template={templateToUse}
                    mediaType={singleLibraryMediaType}
                    type={templateRelevantValues.type}
                    subtype={templateRelevantValues.subtype}
                    customDays={templateRelevantValues.customDays}
                  />
                </div>
              );
            }
          })()}
        </div>
      </div>

      {errors.template && touched.template && (
        <div className="error">{errors.template}</div>
      )}
      <div className="label-tip">
        {(() => {
          // Show variables based on collection type
          const baseVars = 'Media Type - {mediaType}';

          if (values.type === 'overseerr') {
            return `Available variables: Plex Username - {username}, Plex Nickname - {nickname}, Seerr Display Name - {displayName}, Seerr Domain - {domain}, Seerr App Title - {appTitle}, ${baseVars}.`;
          }

          if (values.type === 'tautulli') {
            return `Available variables: Plex Server Name - {servername}, Number of Days - {customdays}, ${baseVars}.`;
          }

          if (
            values.type === 'plex' &&
            (values.subtype === 'actors' || values.subtype === 'directors')
          ) {
            const personType =
              values.subtype === 'actors' ? 'Actor' : 'Director';
            return `Available variables: ${personType} Name - {${
              values.subtype === 'actors' ? 'actor' : 'director'
            }}, ${baseVars}.`;
          }

          if (values.type === 'tmdb' && values.subtype === 'auto_franchise') {
            return `Available variables: Franchise Name - {franchiseName}, ${baseVars}.`;
          }

          // Default for other collection types
          return `Available variables: ${baseVars}.`;
        })()}
      </div>
    </>
  );
};

export default TemplateSection;
