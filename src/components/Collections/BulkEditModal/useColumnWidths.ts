import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'bulkEditColumnWidths';
const CELL_PADDING = 24; // px-3 on both sides
const SORT_ICON = 16;
export const DEFAULT_MIN_WIDTH = 64;

export interface ColumnFit {
  key: string;
  header: string;
  cells?: string[];
  min?: number;
  max?: number;
}

type Measure = (text: string, kind: 'header' | 'cell') => number;

/** Fits the header's longest word (it wraps a word per line) and the longest cell, within the column's bounds. */
export function fitColumnWidth(column: ColumnFit, measure: Measure): number {
  const header =
    Math.max(
      0,
      ...column.header.split(/\s+/).map((word) => measure(word, 'header'))
    ) +
    CELL_PADDING +
    SORT_ICON;
  const cell =
    Math.max(0, ...(column.cells ?? []).map((t) => measure(t, 'cell'))) +
    CELL_PADDING;
  const width = Math.max(column.min ?? DEFAULT_MIN_WIDTH, header, cell);
  return Math.round(Math.min(column.max ?? Infinity, width));
}

// Matches the table's text-xs font-medium headers and text-sm cells.
function createMeasure(): Measure {
  const context =
    typeof document === 'undefined'
      ? null
      : document.createElement('canvas').getContext('2d');
  if (!context) return (text, kind) => text.length * (kind === 'cell' ? 8 : 7);
  const family = getComputedStyle(document.body).fontFamily;
  return (text, kind) => {
    context.font =
      kind === 'header' ? `500 12px ${family}` : `400 14px ${family}`;
    return context.measureText(text).width;
  };
}

function readSaved(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Content-fit column widths that the user can drag to resize; resized widths persist per browser. */
export function useColumnWidths(columns: ColumnFit[]) {
  const fitted = useMemo(() => {
    const measure = createMeasure();
    return Object.fromEntries(
      columns.map((column) => [column.key, fitColumnWidth(column, measure)])
    );
  }, [columns]);
  const [saved, setSaved] = useState<Record<string, number>>(readSaved);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
    } catch {
      // Storage blocked: widths still apply for this session.
    }
  }, [saved]);

  const widthOf = useCallback(
    (key: string) => saved[key] ?? fitted[key] ?? DEFAULT_MIN_WIDTH,
    [saved, fitted]
  );

  const startResize = useCallback(
    (key: string, min = DEFAULT_MIN_WIDTH) =>
      (event: React.PointerEvent<HTMLElement>) => {
        // The header behind the handle sorts on click.
        event.preventDefault();
        event.stopPropagation();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = widthOf(key);
        handle.setPointerCapture(event.pointerId);
        const move = (e: PointerEvent) =>
          setSaved((prev) => ({
            ...prev,
            [key]: Math.max(min, Math.round(startWidth + e.clientX - startX)),
          }));
        const end = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', end);
          handle.removeEventListener('pointercancel', end);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end);
        handle.addEventListener('pointercancel', end);
      },
    [widthOf]
  );

  /** Keyboard resizing for the same handle. */
  const nudgeWidth = useCallback(
    (key: string, delta: number, min = DEFAULT_MIN_WIDTH) =>
      setSaved((prev) => ({
        ...prev,
        [key]: Math.max(min, (prev[key] ?? widthOf(key)) + delta),
      })),
    [widthOf]
  );

  /** One column back to its fitted width, or all of them. */
  const resetWidths = useCallback((key?: string) => {
    setSaved((prev) => {
      if (!key) return {};
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  return {
    widthOf,
    startResize,
    nudgeWidth,
    resetWidths,
    hasResized: Object.keys(saved).length > 0,
  };
}
