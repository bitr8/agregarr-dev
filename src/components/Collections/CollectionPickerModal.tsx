import Modal from '@app/components/Common/Modal';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/solid';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface SourcePickerItem {
  id: string;
  name: string;
  type: string;
}

export interface CollectionPickerItem {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  libraryName?: string;
  sourceCount?: number;
  maxItems?: number;
  sources?: SourcePickerItem[];
}

interface CollectionPickerModalProps {
  title: string;
  actionLabel: string;
  items: CollectionPickerItem[];
  onConfirm: (
    selectedIds: string[],
    sourceSelections: Record<string, string[]>
  ) => void;
  onClose: () => void;
  okDisabled?: boolean;
  children?: React.ReactNode;
}

const CollectionPickerModal: React.FC<CollectionPickerModalProps> = ({
  title,
  actionLabel,
  items,
  onConfirm,
  onClose,
  okDisabled,
  children,
}) => {
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(items.map((i) => i.id))
  );
  const [filterType, setFilterType] = useState('all');
  const [filterLibrary, setFilterLibrary] = useState('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [sourceSelections, setSourceSelections] = useState<
    Record<string, Set<string>>
  >({});

  const types = useMemo(
    () => Array.from(new Set(items.map((i) => i.type))).sort(),
    [items]
  );
  const libraries = useMemo(
    () =>
      Array.from(
        new Set(items.map((i) => i.libraryName).filter(Boolean))
      ).sort() as string[],
    [items]
  );

  const filtered = useMemo(
    () =>
      items.filter(
        (i) =>
          (filterType === 'all' || i.type === filterType) &&
          (filterLibrary === 'all' || i.libraryName === filterLibrary)
      ),
    [items, filterType, filterLibrary]
  );

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((i) => next.add(i.id));
      return next;
    });
  const deselectAll = () =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      filtered.forEach((i) => next.delete(i.id));
      return next;
    });

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const toggleSource = useCallback(
    (itemId: string, sourceId: string, allSourceIds: string[]) => {
      setSourceSelections((prev) => {
        const current = prev[itemId] ?? new Set(allSourceIds);
        const next = new Set(current);
        if (next.has(sourceId)) next.delete(sourceId);
        else next.add(sourceId);
        if (next.size === 0) {
          setSelectedIds((ids) => {
            const n = new Set(ids);
            n.delete(itemId);
            return n;
          });
        }
        return { ...prev, [itemId]: next };
      });
    },
    []
  );

  const toggleParentWithSources = useCallback((item: CollectionPickerItem) => {
    if (!item.sources) return;
    const allIds = item.sources.map((s) => s.id);
    setSelectedIds((prev) => {
      const wasChecked = prev.has(item.id);
      const next = new Set(prev);
      if (wasChecked) {
        next.delete(item.id);
        setSourceSelections((p) => ({
          ...p,
          [item.id]: new Set<string>(),
        }));
      } else {
        next.add(item.id);
        setSourceSelections((p) => ({
          ...p,
          [item.id]: new Set(allIds),
        }));
      }
      return next;
    });
  }, []);

  const count = selectedIds.size;

  const getSourceSel = useCallback(
    (item: CollectionPickerItem): Set<string> | undefined => {
      if (!item.sources?.length) return undefined;
      return (
        sourceSelections[item.id] ?? new Set(item.sources.map((s) => s.id))
      );
    },
    [sourceSelections]
  );

  const subtitle = (item: CollectionPickerItem) => {
    const parts = [item.type];
    if (item.subtype) parts.push(item.subtype);
    if (item.sources?.length) {
      const sel = getSourceSel(item);
      if (sel && sel.size < item.sources.length) {
        parts.push(`${sel.size} of ${item.sources.length} sources`);
      } else {
        parts.push(`${item.sources.length} sources`);
      }
    } else if (item.sourceCount) {
      parts.push(`${item.sourceCount} sources`);
    } else if (item.maxItems) {
      parts.push(`${item.maxItems} items`);
    }
    return parts.join(' · ');
  };

  const handleConfirm = () => {
    const ids = items.filter((i) => selectedIds.has(i.id)).map((i) => i.id);
    const srcSel: Record<string, string[]> = {};
    for (const [itemId, selected] of Object.entries(sourceSelections)) {
      srcSel[itemId] = Array.from(selected);
    }
    onConfirm(ids, srcSel);
  };

  return (
    <Modal
      title={title}
      onCancel={onClose}
      onOk={handleConfirm}
      okText={`${actionLabel} ${count}`}
      okDisabled={count === 0 || okDisabled}
      customMaxWidth="sm:max-w-xl"
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <button
              className="text-xs text-indigo-400 hover:text-indigo-300"
              onClick={selectAll}
            >
              Select All
            </button>
            <button
              className="text-xs text-indigo-400 hover:text-indigo-300"
              onClick={deselectAll}
            >
              Deselect All
            </button>
          </div>
          <span className="text-xs text-gray-400">{count} selected</span>
        </div>

        <div className="flex gap-2">
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="rounded bg-stone-700 px-2 py-1 text-xs text-gray-200"
          >
            <option value="all">All Types</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          {libraries.length > 1 && (
            <select
              value={filterLibrary}
              onChange={(e) => setFilterLibrary(e.target.value)}
              className="rounded bg-stone-700 px-2 py-1 text-xs text-gray-200"
            >
              <option value="all">All Libraries</option>
              {libraries.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="max-h-80 space-y-1 overflow-y-auto">
          {filtered.map((item) => {
            const hasSources = item.sources && item.sources.length > 0;
            const isExpanded = hasSources && expanded[item.id];
            const sourceSel = getSourceSel(item);
            const allSourcesSelected =
              hasSources &&
              sourceSel &&
              sourceSel.size === item.sources!.length;
            const someSourcesSelected =
              hasSources &&
              sourceSel &&
              sourceSel.size > 0 &&
              !allSourcesSelected;

            if (!hasSources) {
              return (
                <label
                  key={item.id}
                  className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-stone-700"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(item.id)}
                    onChange={() => toggle(item.id)}
                    className="mt-0.5 rounded border-gray-600 bg-stone-700 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-gray-200">
                      {item.name}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {subtitle(item)}
                    </div>
                  </div>
                </label>
              );
            }

            return (
              <div key={item.id}>
                <div className="flex items-start gap-1 rounded px-2 py-1.5 hover:bg-stone-700">
                  <button
                    type="button"
                    onClick={() => toggleExpanded(item.id)}
                    aria-expanded={!!isExpanded}
                    aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${
                      item.name
                    } sources`}
                    className="mt-0.5 flex-shrink-0 text-gray-400 hover:text-gray-200"
                  >
                    {isExpanded ? (
                      <ChevronDownIcon className="h-4 w-4" />
                    ) : (
                      <ChevronRightIcon className="h-4 w-4" />
                    )}
                  </button>
                  <ParentCheckbox
                    checked={selectedIds.has(item.id)}
                    indeterminate={
                      selectedIds.has(item.id) && !!someSourcesSelected
                    }
                    onChange={() => toggleParentWithSources(item)}
                    aria-label={item.name}
                  />
                  <button
                    type="button"
                    className="min-w-0 flex-1 text-left"
                    onClick={() => toggleExpanded(item.id)}
                  >
                    <div className="truncate text-sm text-gray-200">
                      {item.name}
                    </div>
                    <div className="truncate text-xs text-gray-500">
                      {subtitle(item)}
                    </div>
                  </button>
                </div>
                {isExpanded && (
                  <div className="ml-9 space-y-0.5 border-l border-stone-600 pl-2">
                    {item.sources!.map((source, idx) => (
                      <label
                        key={source.id}
                        className="flex cursor-pointer items-start gap-2 rounded px-2 py-1 hover:bg-stone-700/50"
                      >
                        <input
                          type="checkbox"
                          checked={sourceSel?.has(source.id) ?? true}
                          onChange={() =>
                            toggleSource(
                              item.id,
                              source.id,
                              item.sources!.map((s) => s.id)
                            )
                          }
                          className="mt-0.5 rounded border-gray-600 bg-stone-700 text-indigo-500 focus:ring-indigo-500"
                        />
                        <div className="min-w-0">
                          <div className="truncate text-sm text-gray-300">
                            {idx + 1}. {source.name}
                          </div>
                          <div className="truncate text-xs text-gray-500">
                            {source.type}
                          </div>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
          {filtered.length === 0 && (
            <p className="py-4 text-center text-sm text-gray-500">
              No collections match the current filters.
            </p>
          )}
        </div>

        {children}
      </div>
    </Modal>
  );
};

const ParentCheckbox: React.FC<{
  checked: boolean;
  indeterminate: boolean;
  onChange: () => void;
  'aria-label'?: string;
}> = ({ checked, indeterminate, onChange, ...rest }) => {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      className="mt-0.5 flex-shrink-0 rounded border-gray-600 bg-stone-700 text-indigo-500 focus:ring-indigo-500"
      {...rest}
    />
  );
};

export default CollectionPickerModal;
