import type { OverlayElement } from './types';

export function isResizable(type: OverlayElement['type']): boolean {
  return type !== 'mapped-icon';
}
