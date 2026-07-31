import Modal from '@app/components/Common/Modal';
import type React from 'react';
import { useMemo, useState } from 'react';

export interface CollectionPickerItem {
  id: string;
  name: string;
  type: string;
  subtype?: string;
  libraryName?: string;
  sourceCount?: number;
  maxItems?: number;
}

interface CollectionPickerModalProps {
  title: string;
  actionLabel: string;
  items: CollectionPickerItem[];
  onConfirm: (selectedIds: string[]) => void;
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

  const count = selectedIds.size;

  const subtitle = (item: CollectionPickerItem) => {
    const parts = [item.type];
    if (item.subtype) parts.push(item.subtype);
    if (item.sourceCount) parts.push(`${item.sourceCount} sources`);
    else if (item.maxItems) parts.push(`${item.maxItems} items`);
    return parts.join(' · ');
  };

  return (
    <Modal
      title={title}
      onCancel={onClose}
      onOk={() => {
        const ids = items.filter((i) => selectedIds.has(i.id)).map((i) => i.id);
        onConfirm(ids);
      }}
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
          {filtered.map((item) => (
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
          ))}
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

export default CollectionPickerModal;
