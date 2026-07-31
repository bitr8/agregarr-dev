import type { CollectionPickerItem } from '@app/components/Collections/CollectionPickerModal';
import type { CollectionFormConfig } from '@app/types/collections';
import { useCallback, useMemo, useState } from 'react';
import { useToasts } from 'react-toast-notifications';

export function useCollectionExport(configs: CollectionFormConfig[]) {
  const [showExportPicker, setShowExportPicker] = useState(false);
  const { addToast } = useToasts();

  const exportPickerItems: CollectionPickerItem[] = useMemo(
    () =>
      configs.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type || 'unknown',
        subtype: c.subtype,
        libraryName: c.libraryName,
        sourceCount: Array.isArray(c.sources) ? c.sources.length : undefined,
        maxItems: c.maxItems,
      })),
    [configs]
  );

  const handleExport = useCallback(
    async (selectedIds: string[]) => {
      try {
        const res = await fetch('/api/v1/collections/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: selectedIds }),
        });

        if (!res.ok) {
          const err = await res
            .json()
            .catch(() => ({ error: 'Export failed' }));
          throw new Error(err.error || 'Export failed');
        }

        const blob = await res.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;

        const disposition = res.headers.get('Content-Disposition');
        const filenameMatch = disposition?.match(/filename="(.+?)"/);
        link.download =
          filenameMatch?.[1] || 'agregarr-collections-export.json';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);

        setShowExportPicker(false);
        addToast(`${selectedIds.length} collection(s) exported.`, {
          appearance: 'success',
          autoDismiss: true,
        });
      } catch (err) {
        addToast(err instanceof Error ? err.message : 'Export failed.', {
          appearance: 'error',
          autoDismiss: true,
        });
      }
    },
    [addToast]
  );

  return {
    showExportPicker,
    setShowExportPicker,
    exportPickerItems,
    handleExport,
  };
}
