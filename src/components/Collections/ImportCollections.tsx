import type { CollectionPickerItem } from '@app/components/Collections/CollectionPickerModal';
import CollectionPickerModal from '@app/components/Collections/CollectionPickerModal';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import type React from 'react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useToasts } from 'react-toast-notifications';
import useSWR, { mutate } from 'swr';

interface ExportEnvelope {
  version?: string;
  collections?: Record<string, unknown>[];
}

interface ImportCollectionsProps {
  trigger: React.ReactNode;
}

const ImportCollections: React.FC<ImportCollectionsProps> = ({ trigger }) => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<Record<string, unknown>[] | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [selectedLibrary, setSelectedLibrary] = useState('');
  const [importing, setImporting] = useState(false);
  const { addToast } = useToasts();

  const { data: libraries = [] } = useSWR<
    { key: string; name: string; type: string }[]
  >('/api/v1/settings/plex/libraries');

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      if (file.size > 1024 * 1024) {
        addToast('File too large (max 1 MB).', {
          appearance: 'error',
          autoDismiss: true,
        });
        e.target.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const json = JSON.parse(
            ev.target?.result as string
          ) as ExportEnvelope;

          if (json.version && json.version !== '1.0') {
            addToast(
              `Unsupported export version: ${json.version}. This version supports 1.0.`,
              { appearance: 'error', autoDismiss: true }
            );
            return;
          }

          if (
            !Array.isArray(json.collections) ||
            json.collections.length === 0
          ) {
            addToast('No collections found in file.', {
              appearance: 'error',
              autoDismiss: true,
            });
            return;
          }

          const invalid = json.collections.find((c) => !c.name || !c.type);
          if (invalid) {
            addToast('Invalid collection data: each must have name and type.', {
              appearance: 'error',
              autoDismiss: true,
            });
            return;
          }

          setParsed(json.collections);
          setSelectedLibrary('');
          setShowPicker(true);
        } catch {
          addToast('Invalid JSON file.', {
            appearance: 'error',
            autoDismiss: true,
          });
        }
      };
      reader.readAsText(file);

      // Reset so the same file can be selected again
      e.target.value = '';
    },
    [addToast]
  );

  const pickerItems: CollectionPickerItem[] = useMemo(
    () =>
      (parsed || []).map((c, i) => ({
        id: String(i),
        name: String(c.name || ''),
        type: String(c.type || ''),
        subtype: c.subtype ? String(c.subtype) : undefined,
        sourceCount: Array.isArray(c.sources) ? c.sources.length : undefined,
        maxItems: typeof c.maxItems === 'number' ? c.maxItems : undefined,
        sources:
          c.isMultiSource && Array.isArray(c.sources)
            ? (c.sources as Record<string, unknown>[]).map((s, j) => ({
                id: String(j),
                name:
                  String(s.resolvedTitle || s.customUrl || '') ||
                  `Source ${j + 1}`,
                type: String(s.type || ''),
              }))
            : undefined,
      })),
    [parsed]
  );

  const serviceWarnings = useMemo(() => {
    if (!parsed) return [];
    const warnings: string[] = [];
    const types = new Set(parsed.map((c) => c.type));

    if (types.has('overseerr'))
      warnings.push('Requires Overseerr to be configured.');
    if (types.has('tautulli'))
      warnings.push('Requires Tautulli to be configured.');
    if (types.has('radarrtag'))
      warnings.push('Requires Radarr to be configured (tag-based).');
    if (types.has('sonarrtag'))
      warnings.push('Requires Sonarr to be configured (tag-based).');
    if (types.has('networks')) warnings.push('Uses FlixPatrol scraping.');
    if (types.has('originals')) warnings.push('Requires MDBList API key.');
    if (parsed.some((c) => c.createPlaceholdersForMissing))
      warnings.push(
        'Creates placeholders — configure Radarr/Sonarr for download status.'
      );
    if (parsed.some((c) => c.comingSoonFilterByTags))
      warnings.push('Filters by arr tags — configure servers after import.');

    if (parsed.some((c) => c.downloadMode === 'direct'))
      warnings.push(
        'Uses direct download. Configure Radarr/Sonarr after import.'
      );
    if (
      parsed.some(
        (c) => c.downloadMode === 'overseerr' && c.type !== 'overseerr'
      )
    )
      warnings.push('Uses Overseerr for requests. Configure after import.');

    return warnings;
  }, [parsed]);

  const handleImport = useCallback(
    async (
      selectedIds: string[],
      sourceSelections: Record<string, string[]>
    ) => {
      if (!parsed || !selectedLibrary) return;

      const selected = selectedIds.map((i) => {
        const coll = parsed[parseInt(i, 10)];
        if (
          coll.isMultiSource &&
          Array.isArray(coll.sources) &&
          sourceSelections[i]
        ) {
          const kept = new Set(sourceSelections[i]);
          return {
            ...coll,
            sources: (coll.sources as Record<string, unknown>[]).filter(
              (_, j) => kept.has(String(j))
            ),
          };
        }
        return coll;
      });

      setImporting(true);
      try {
        const res = await fetch('/api/v1/collections/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            version: '1.0',
            collections: selected,
            libraryId: selectedLibrary,
          }),
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: 'Import failed' }));
          throw new Error(err.error || 'Import failed');
        }

        const result = await res.json();
        addToast(`${result.count} collection(s) imported.`, {
          appearance: 'success',
          autoDismiss: true,
        });

        mutate('/api/v1/collections');
        setShowPicker(false);
        setParsed(null);
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Import failed.', {
          appearance: 'error',
          autoDismiss: true,
        });
      } finally {
        setImporting(false);
      }
    },
    [parsed, selectedLibrary, addToast]
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onClick={() => fileInputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInputRef.current?.click();
          }
        }}
        className="inline-block"
      >
        {trigger}
      </div>
      <input
        type="file"
        ref={fileInputRef}
        accept=".json"
        onChange={handleFileSelect}
        className="hidden"
      />
      {showPicker && parsed && (
        <CollectionPickerModal
          title="Import Collections"
          actionLabel="Import"
          items={pickerItems}
          onConfirm={handleImport}
          onClose={() => {
            setShowPicker(false);
            setParsed(null);
          }}
          okDisabled={!selectedLibrary || importing}
        >
          <div className="mt-3 space-y-2 border-t border-stone-700 pt-3">
            <div className="flex items-center gap-2">
              <label
                htmlFor="import-library-select"
                className="text-xs text-gray-400"
              >
                Library:
              </label>
              <select
                id="import-library-select"
                value={selectedLibrary}
                onChange={(e) => setSelectedLibrary(e.target.value)}
                className="rounded bg-stone-700 px-2 py-1 text-xs text-gray-200"
              >
                <option value="">Select library</option>
                {libraries.map((lib) => (
                  <option key={lib.key} value={lib.key}>
                    {lib.name}
                  </option>
                ))}
              </select>
            </div>
            {serviceWarnings.length > 0 && (
              <div className="space-y-1">
                {serviceWarnings.map((w) => (
                  <div
                    key={w}
                    className="flex items-start gap-1 text-xs text-amber-400"
                  >
                    <ExclamationTriangleIcon className="mt-0.5 h-3 w-3 shrink-0" />
                    <span>{w}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CollectionPickerModal>
      )}
    </>
  );
};

export default ImportCollections;
