import { isOverlayDateField } from '@server/lib/overlays/overlayDateFields';
import {
  DEFAULT_DATE_FORMAT,
  formatDateInTimezone,
} from '@server/utils/dateFormats';
import {
  formatNumberSegment,
  isOverlayNumberFormatField,
} from '@server/utils/numberFormats';
import type {
  OverlayRenderContext,
  OverlayVariableElementProps,
  OverlayVariableSegment,
} from './types';
import { AVAILABLE_VARIABLES, isCollectionRankField } from './types';

const sampleText = (
  example: string | undefined,
  segment: OverlayVariableSegment
): string => {
  if (!example) return `{${segment.field}}`;
  return /^\d+$/.test(example)
    ? formatNumberSegment(Number(example), segment.format, segment.field)
    : example;
};

export const isNumberFormatVariable = isOverlayNumberFormatField;

export const buildVariableDisplayText = (
  props: OverlayVariableElementProps,
  renderContext?: OverlayRenderContext,
  timeZone = 'UTC'
): string => {
  let text = '';

  // Build array of all available variables for lookup
  const allVars = Object.values(AVAILABLE_VARIABLES).flat();

  for (const segment of props.segments) {
    if (segment.type === 'text') {
      // Static text segment - use value as-is
      text += segment.value || '';
    } else if (segment.type === 'variable' && segment.field) {
      // Variable segment - look up value in context
      if (renderContext) {
        const value = renderContext[segment.field];
        if (value !== undefined && value !== null) {
          // Check if this is a date field with custom format
          const isDateField = isOverlayDateField(segment.field);
          if (
            isDateField &&
            (typeof value === 'string' || value instanceof Date)
          ) {
            // Use specified format or default to 'MMM DD'
            text += formatDateInTimezone(
              value,
              segment.format || DEFAULT_DATE_FORMAT,
              timeZone
            );
          } else if (typeof value === 'number') {
            // Format numbers appropriately
            if (
              segment.field === 'imdbRating' ||
              segment.field === 'tmdbRating'
            ) {
              // IMDb/TMDB ratings use a 0-10 decimal scale (e.g., 8.7)
              text += value.toFixed(1);
            } else if (
              segment.field.includes('Score') ||
              segment.field.includes('Rating')
            ) {
              // RT scores are percentages - no decimal needed (e.g., 89)
              text += Math.round(value).toString();
            } else {
              text += formatNumberSegment(value, segment.format, segment.field);
            }
          } else {
            text += String(value);
          }
        } else {
          // Fallback to example value if available
          const varInfo = allVars.find(
            (v) =>
              v.field ===
              (isCollectionRankField(segment.field)
                ? 'collectionRank'
                : segment.field)
          );
          text += sampleText(varInfo?.example, segment);
        }
      } else {
        // No context - show example value instead of raw variable
        const varInfo = allVars.find(
          (v) =>
            v.field ===
            (isCollectionRankField(segment.field)
              ? 'collectionRank'
              : segment.field)
        );
        text += sampleText(varInfo?.example, segment);
      }
    }
  }

  return text;
};
