import type {
  ColorScale,
  IconMapping,
  OverlayElement,
  OverlayMappedIconElementProps,
  OverlayRasterElementProps,
  OverlaySVGElementProps,
  OverlayTemplateData,
  OverlayTextElementProps,
  OverlayTileElementProps,
  OverlayVariableElementProps,
} from '@server/entity/OverlayTemplate';
import logger from '@server/logger';
import fs from 'fs';
import path from 'path';
import sharp, { type OverlayOptions } from 'sharp';
import { colorScaleContextField, colorScaleFraction } from './colorScaleField';
import { evaluateCondition } from './conditionEvaluator';
import { mappedIconContentSize } from './mappedIconLayout';
import { isOverlayDateField } from './overlayDateFields';
import {
  DEFAULT_OVERLAY_JPEG_QUALITY,
  normalizeOverlayJpegQuality,
  overlayOutputFormat,
} from './overlayOutputQuality';
import type { OverlayRenderContext } from './overlayRenderContext';
import { AGREGARR_OVERLAY_MARKER } from './posterOwnershipMetadata';
import { resolveTileCornerRadii, roundedRectPath } from './roundedRect';
import { DEFAULT_TILE_BORDER_COLOR, insetTileBorder } from './tileBorder';
import { getMergedMappings } from './UserMappingsService';

export {
  evaluateCondition,
  evaluateConditionDetailed,
} from './conditionEvaluator';
export type { OverlayRenderContext } from './overlayRenderContext';

function parseHex(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [
    parseInt(h.substring(0, 2), 16),
    parseInt(h.substring(2, 4), 16),
    parseInt(h.substring(4, 6), 16),
  ];
}

function toHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b].map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')
  );
}

function lerpColor(a: string, b: string, t: number): string {
  const [ar, ag, ab] = parseHex(a);
  const [br, bg, bb] = parseHex(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function resolveColorScale(
  scale: ColorScale,
  context: OverlayRenderContext
): string | null {
  const raw = context[colorScaleContextField(scale.field)];
  if (typeof raw !== 'number') return null;
  const t = colorScaleFraction(raw, scale.min, scale.max);
  if (scale.midColor) {
    return t < 0.5
      ? lerpColor(scale.fromColor, scale.midColor, t * 2)
      : lerpColor(scale.midColor, scale.toColor, (t - 0.5) * 2);
  }
  return lerpColor(scale.fromColor, scale.toColor, t);
}

export async function applyOpacityAndGrayscale(
  input: Buffer,
  opacity: number | undefined,
  grayscale: boolean | undefined
): Promise<Buffer> {
  const fade = opacity === undefined || opacity >= 100 ? 1 : opacity / 100;
  if (fade === 1 && !grayscale) return input;

  const source = grayscale
    ? await sharp(input).grayscale().png().toBuffer()
    : input;
  const { data, info } = await sharp(source)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (fade !== 1) {
    for (let i = info.channels - 1; i < data.length; i += info.channels) {
      data[i] = Math.round(data[i] * Math.max(0, fade));
    }
  }
  return await sharp(data, {
    raw: { width: info.width, height: info.height, channels: info.channels },
  })
    .png()
    .toBuffer();
}

/**
 * Service for rendering overlay templates onto posters
 */
class OverlayTemplateRendererService {
  /**
   * Check if all required variables are available in the context
   */
  private hasRequiredVariables(
    elements: OverlayElement[],
    context: OverlayRenderContext
  ): boolean {
    const variableElements = elements.filter(
      (el) => el.type === 'variable' && evaluateCondition(el.condition, context)
    );

    if (variableElements.length === 0) {
      return true;
    }

    for (const element of variableElements) {
      const props = element.properties as OverlayVariableElementProps;

      for (const segment of props.segments) {
        if (segment.type === 'variable' && segment.field) {
          const value = context[segment.field];

          if (value === undefined || value === null) {
            return false;
          }
        }
      }
    }

    return true;
  }

  /**
   * Get poster dimensions from a buffer
   */
  async getPosterDimensions(
    posterBuffer: Buffer
  ): Promise<{ width: number; height: number }> {
    const metadata = await sharp(posterBuffer).metadata();
    return {
      width: metadata.width || 500,
      height: metadata.height || 750,
    };
  }

  /**
   * Render overlay elements for a template without compositing.
   * Returns positioned overlay buffers ready for batch compositing,
   * or null if the template should be skipped (missing required variables).
   */
  async renderOverlayElements(
    posterWidth: number,
    posterHeight: number,
    templateData: OverlayTemplateData,
    context: OverlayRenderContext
  ): Promise<OverlayOptions[] | null> {
    try {
      const elements = templateData.elements;

      // Check if all required variables are available
      if (!this.hasRequiredVariables(elements, context)) {
        logger.debug('Skipping overlay - required data not available', {
          label: 'OverlayRenderer',
        });
        return null;
      }

      // Calculate scale factors from template canvas to actual poster
      // Use uniform scaling to prevent overlay drift on non-standard aspect ratios
      const scaleX = posterWidth / templateData.width;
      const scaleY = posterHeight / templateData.height;
      const scale = Math.min(scaleX, scaleY);

      // Calculate offsets to center the template on non-standard posters
      const offsetX = (posterWidth - templateData.width * scale) / 2;
      const offsetY = (posterHeight - templateData.height * scale) / 2;

      logger.debug('Rendering overlay elements', {
        label: 'OverlayRenderer',
        posterDimensions: `${posterWidth}x${posterHeight}`,
        templateDimensions: `${templateData.width}x${templateData.height}`,
        scaleFactor: scale.toFixed(2),
        offsets: `${offsetX.toFixed(1)},${offsetY.toFixed(1)}`,
        elementCount: elements.length,
      });

      // Sort elements by layer order (bottom to top)
      const sortedElements = [...elements].sort(
        (a, b) => a.layerOrder - b.layerOrder
      );

      // Render each element as an overlay
      const overlays: OverlayOptions[] = [];

      for (const element of sortedElements) {
        if (
          element.condition &&
          !evaluateCondition(element.condition, context)
        ) {
          continue;
        }

        const overlayBuffer = await this.renderElement(
          element,
          posterWidth,
          posterHeight,
          templateData.width,
          templateData.height,
          context
        );

        if (overlayBuffer) {
          // The unrotated buffer's centre is the element's anchor point
          // (matches the editor for fixed-size and auto-sized elements alike)
          const unrotatedMeta = await sharp(overlayBuffer).metadata();
          const anchorWidth = unrotatedMeta.width ?? 0;
          const anchorHeight = unrotatedMeta.height ?? 0;
          let overlayWidth = anchorWidth;
          let overlayHeight = anchorHeight;

          let safeOverlayBuffer = overlayBuffer;

          if (element.rotation && element.rotation !== 0) {
            // sharp.rotate() expands the canvas; content stays centred in it
            safeOverlayBuffer = await this.applyRotation(
              safeOverlayBuffer,
              element.rotation
            );
            const rotatedMeta = await sharp(safeOverlayBuffer).metadata();
            overlayWidth = rotatedMeta.width ?? overlayWidth;
            overlayHeight = rotatedMeta.height ?? overlayHeight;
          }

          let left =
            Math.round(offsetX + element.x * scale + anchorWidth / 2) -
            Math.round(overlayWidth / 2);
          let top =
            Math.round(offsetY + element.y * scale + anchorHeight / 2) -
            Math.round(overlayHeight / 2);

          // sharp rejects overlays larger than the poster; crop the overflow like the editor does
          if (overlayWidth > posterWidth || overlayHeight > posterHeight) {
            const cropLeft = Math.max(0, -left);
            const cropTop = Math.max(0, -top);
            const width = Math.min(overlayWidth, posterWidth - left) - cropLeft;
            const height =
              Math.min(overlayHeight, posterHeight - top) - cropTop;
            if (width <= 0 || height <= 0) {
              continue;
            }
            safeOverlayBuffer = await sharp(safeOverlayBuffer)
              .extract({ left: cropLeft, top: cropTop, width, height })
              .toBuffer();
            left += cropLeft;
            top += cropTop;
          }

          overlays.push({
            input: safeOverlayBuffer,
            left,
            top,
          });
        }
      }

      return overlays;
    } catch (error) {
      logger.error('Failed to render overlay elements', {
        label: 'OverlayRenderer',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Composite all overlay elements onto a poster in a single operation
   */
  async compositeOverlays(
    posterBuffer: Buffer,
    overlays: OverlayOptions[],
    jpegQuality = DEFAULT_OVERLAY_JPEG_QUALITY,
    outputFormat = overlayOutputFormat()
  ): Promise<Buffer> {
    let composite = sharp(posterBuffer);

    if (overlays.length > 0) {
      composite = composite.composite(overlays);
    }

    if (outputFormat === 'webp') {
      return await composite.webp({ quality: 92 }).toBuffer();
    }

    // Posterizarr writes its marker as a JPEG comment, not EXIF, and Sharp does
    // not carry JPEG comments through re-encoding. Add our own explicit overlay
    // marker as EXIF near the beginning of the JPEG, inside Posterizarr's 64-KiB
    // metadata scan. withExifMerge also retains any real source EXIF tags.
    return await composite
      .withExifMerge({
        IFD0: { ImageDescription: AGREGARR_OVERLAY_MARKER },
      })
      .jpeg({
        quality: normalizeOverlayJpegQuality(jpegQuality),
        // Preserve full colour detail around small text and badge edges. Sharp's
        // JPEG default is 4:2:0, which visibly softens coloured overlays.
        chromaSubsampling: '4:4:4',
      })
      .toBuffer();
  }

  /**
   * Render overlay template onto a poster (single-template convenience method)
   */
  async renderOverlay(
    posterBuffer: Buffer,
    templateData: OverlayTemplateData,
    context: OverlayRenderContext,
    jpegQuality = DEFAULT_OVERLAY_JPEG_QUALITY
  ): Promise<Buffer> {
    const { width, height } = await this.getPosterDimensions(posterBuffer);
    const overlays = await this.renderOverlayElements(
      width,
      height,
      templateData,
      context
    );

    // If template was skipped (missing variables), return original poster
    if (!overlays) {
      return posterBuffer;
    }

    return await this.compositeOverlays(posterBuffer, overlays, jpegQuality);
  }

  /**
   * Render a single overlay element
   */
  private async renderElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number,
    context: OverlayRenderContext
  ): Promise<Buffer | null> {
    try {
      let buffer: Buffer | null = null;

      switch (element.type) {
        case 'text':
          buffer = await this.renderTextElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight
          );
          break;
        case 'tile':
          buffer = await this.renderTileElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight,
            context
          );
          break;
        case 'variable':
          buffer = await this.renderVariableElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight,
            context
          );
          break;
        case 'svg':
          buffer = await this.renderSVGElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight
          );
          break;
        case 'raster':
          buffer = await this.renderRasterElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight
          );
          break;
        case 'mapped-icon':
          buffer = await this.renderMappedIconElement(
            element,
            posterWidth,
            posterHeight,
            templateWidth,
            templateHeight,
            context
          );
          break;
        default:
          logger.warn('Unknown element type', {
            label: 'OverlayRenderer',
            type: element.type,
          });
          return null;
      }

      // Rotation is applied by the caller after the unrotated buffer's
      // dimensions have been captured for positioning
      return buffer;
    } catch (error) {
      logger.error('Failed to render element', {
        label: 'OverlayRenderer',
        elementType: element.type,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Apply rotation to an element buffer
   */
  private async applyRotation(
    buffer: Buffer,
    rotation: number
  ): Promise<Buffer> {
    try {
      // For rotation, we need to rotate the image
      // Sharp's rotate() automatically expands the canvas to fit rotated content
      return await sharp(buffer)
        .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
    } catch (error) {
      logger.warn('Failed to apply rotation, returning unrotated buffer', {
        label: 'OverlayRenderer',
        rotation,
        error: error instanceof Error ? error.message : String(error),
      });
      return buffer;
    }
  }

  /**
   * Render pure text element (no background, no dynamic fields)
   */
  private async renderTextElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number
  ): Promise<Buffer> {
    const props = element.properties as OverlayTextElementProps;

    // Calculate uniform scale factor to handle non-standard aspect ratios
    const scaleX = posterWidth / templateWidth;
    const scaleY = posterHeight / templateHeight;
    const scale = Math.min(scaleX, scaleY);

    // Scale dimensions from template to poster using uniform scale
    const width = Math.round(element.width * scale);
    const height = Math.round(element.height * scale);
    const fontSize = Math.round(props.fontSize * scale);

    // Create SVG for text rendering
    const svg = `
      <svg width="${width}" height="${height}">
        <text
          x="${
            props.textAlign === 'center'
              ? '50%'
              : props.textAlign === 'right'
              ? '100%'
              : '0'
          }"
          y="50%"
          font-family="'${props.fontFamily}'"
          font-size="${fontSize}"
          font-weight="${props.fontWeight}"
          font-style="${props.fontStyle}"
          fill="${props.color}"
          fill-opacity="${(props.opacity ?? 100) / 100}"
          text-anchor="${
            props.textAlign === 'center'
              ? 'middle'
              : props.textAlign === 'right'
              ? 'end'
              : 'start'
          }"
          dominant-baseline="middle"
        >
          ${this.escapeXml(props.text)}
        </text>
      </svg>
    `;

    return await sharp(Buffer.from(svg)).png().toBuffer();
  }

  /**
   * Render tile element (decorative rectangle)
   */
  private async renderTileElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number,
    context: OverlayRenderContext
  ): Promise<Buffer> {
    const props = element.properties as OverlayTileElementProps;
    const fillColor =
      (props.colorScale && resolveColorScale(props.colorScale, context)) ||
      props.fillColor;

    // Calculate uniform scale factor to handle non-standard aspect ratios
    const scaleX = posterWidth / templateWidth;
    const scaleY = posterHeight / templateHeight;
    const scale = Math.min(scaleX, scaleY);

    // Scale dimensions from template to poster using uniform scale
    const width = Math.round(element.width * scale);
    const height = Math.round(element.height * scale);
    const borderWidth = props.borderWidth
      ? Math.round(props.borderWidth * scale)
      : 0;

    const path = roundedRectPath(
      width,
      height,
      resolveTileCornerRadii(props, scale)
    );

    let borderPath = '';
    if (borderWidth > 0) {
      const inner = insetTileBorder(
        width,
        height,
        resolveTileCornerRadii(props, scale),
        borderWidth
      );
      borderPath = `<path transform="translate(${inner.inset} ${
        inner.inset
      })" d="${roundedRectPath(
        inner.width,
        inner.height,
        inner.radii
      )}" fill="none" stroke="${
        props.borderColor || DEFAULT_TILE_BORDER_COLOR
      }" stroke-width="${inner.strokeWidth}" />`;
    }

    const svg = `
      <svg width="${width}" height="${height}">
        <path
          d="${path}"
          fill="${fillColor}"
          fill-opacity="${props.fillOpacity / 100}"
        />
        ${borderPath}
      </svg>
    `;

    return await sharp(Buffer.from(svg)).png().toBuffer();
  }

  /**
   * Render variable element by composing text from multiple segments
   * Returns null if any required variable has no value (for partial rendering)
   */
  private async renderVariableElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number,
    context: OverlayRenderContext
  ): Promise<Buffer | null> {
    const props = element.properties as OverlayVariableElementProps;

    // Build display text by concatenating all segments
    let displayText = '';

    for (const segment of props.segments) {
      if (segment.type === 'text') {
        // Static text segment - use value as-is
        displayText += segment.value || '';
      } else if (segment.type === 'variable' && segment.field) {
        // Variable segment - look up value in context
        const variableValue = context[segment.field];

        // If any variable has no value, don't render this element (partial rendering)
        if (variableValue === undefined || variableValue === null) {
          return null;
        }

        // Format the value based on type
        let formattedValue = '';

        // Check if this is a date field with custom format
        const isDateField = isOverlayDateField(segment.field);

        if (
          isDateField &&
          (typeof variableValue === 'string' || variableValue instanceof Date)
        ) {
          // Use date formatting - use specified format or default to 'MMM DD'
          const { formatDate } = await import('@server/utils/dateHelpers');
          formattedValue = formatDate(
            variableValue,
            segment.format || 'MMM DD'
          );
        } else if (typeof variableValue === 'number') {
          // Format ratings/scores appropriately
          if (
            segment.field === 'imdbRating' ||
            segment.field === 'tmdbRating'
          ) {
            // IMDb/TMDB ratings use a 0-10 decimal scale (e.g., 8.7)
            formattedValue = variableValue.toFixed(1);
          } else if (
            segment.field.includes('Score') ||
            segment.field.includes('Rating')
          ) {
            // RT scores are percentages - no decimal needed (e.g., 89)
            formattedValue = Math.round(variableValue).toString();
          } else {
            formattedValue = variableValue.toString();
          }
        } else {
          formattedValue = String(variableValue);
        }

        displayText += formattedValue;
      }
    }

    // Calculate uniform scale factor to handle non-standard aspect ratios
    const scaleX = posterWidth / templateWidth;
    const scaleY = posterHeight / templateHeight;
    const scale = Math.min(scaleX, scaleY);

    // Scale dimensions from template to poster using uniform scale
    const width = Math.round(element.width * scale);
    const height = Math.round(element.height * scale);
    const fontSize = Math.round(props.fontSize * scale);

    // Create SVG for text rendering
    const svg = `
      <svg width="${width}" height="${height}">
        <text
          x="${
            props.textAlign === 'center'
              ? '50%'
              : props.textAlign === 'right'
              ? '100%'
              : '0'
          }"
          y="50%"
          font-family="'${props.fontFamily}'"
          font-size="${fontSize}"
          font-weight="${props.fontWeight}"
          font-style="${props.fontStyle}"
          fill="${props.color}"
          fill-opacity="${(props.opacity ?? 100) / 100}"
          text-anchor="${
            props.textAlign === 'center'
              ? 'middle'
              : props.textAlign === 'right'
              ? 'end'
              : 'start'
          }"
          dominant-baseline="middle"
        >
          ${this.escapeXml(displayText)}
        </text>
      </svg>
    `;

    return await sharp(Buffer.from(svg)).png().toBuffer();
  }

  /**
   * Render SVG icon element
   */
  private async renderSVGElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number
    // context parameter reserved for future dynamic field support
  ): Promise<Buffer | null> {
    const props = element.properties as OverlaySVGElementProps;

    // Calculate uniform scale factor to handle non-standard aspect ratios
    const scaleX = posterWidth / templateWidth;
    const scaleY = posterHeight / templateHeight;
    const scale = Math.min(scaleX, scaleY);

    // Scale dimensions from template to poster using uniform scale
    const width = Math.round(element.width * scale);
    const height = Math.round(element.height * scale);

    // Load SVG file
    if (props.iconPath) {
      try {
        // Parse icon path URL to get type and filename
        // Format: /api/v1/posters/icons/{type}/{filename}
        const urlMatch = props.iconPath.match(
          /\/api\/v1\/posters\/icons\/(\w+)\/(.+)/
        );
        if (!urlMatch) {
          logger.warn('Icon path does not match expected format', {
            label: 'OverlayRenderer',
            iconPath: props.iconPath,
          });
          return null;
        }

        const [, iconType, filename] = urlMatch;

        // Load icon file using iconManager (same as poster template editor)
        const { loadIconFile } = await import('@server/lib/iconManager');
        const svgBuffer = await loadIconFile(
          filename,
          iconType as 'user' | 'system'
        );

        const icon = await sharp(svgBuffer)
          .resize(width, height, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();
        return await applyOpacityAndGrayscale(
          icon,
          props.opacity,
          props.grayscale
        );
      } catch (error) {
        logger.error('Failed to load SVG icon', {
          label: 'OverlayRenderer',
          iconPath: props.iconPath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    return null;
  }

  /**
   * Render raster image element
   */
  private async renderRasterElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number
    // context parameter reserved for future dynamic field support
  ): Promise<Buffer | null> {
    const props = element.properties as OverlayRasterElementProps;

    // Calculate uniform scale factor to handle non-standard aspect ratios
    const scaleX = posterWidth / templateWidth;
    const scaleY = posterHeight / templateHeight;
    const scale = Math.min(scaleX, scaleY);

    // Scale dimensions from template to poster using uniform scale
    const width = Math.round(element.width * scale);
    const height = Math.round(element.height * scale);

    // Load raster image
    if (props.imagePath) {
      try {
        // Parse image path URL to get type and filename
        // Format: /api/v1/posters/icons/{type}/{filename}
        const urlMatch = props.imagePath.match(
          /\/api\/v1\/posters\/icons\/(\w+)\/(.+)/
        );
        if (!urlMatch) {
          logger.warn('Image path does not match expected format', {
            label: 'OverlayRenderer',
            imagePath: props.imagePath,
          });
          return null;
        }

        const [, iconType, filename] = urlMatch;

        // Load image file using iconManager (same as poster template editor)
        const { loadIconFile } = await import('@server/lib/iconManager');
        const imageBuffer = await loadIconFile(
          filename,
          iconType as 'user' | 'system'
        );

        // Resize with 'contain' to maintain aspect ratio (match editor behavior)
        const image = await sharp(imageBuffer)
          .resize(width, height, {
            fit: 'contain',
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();
        return await applyOpacityAndGrayscale(image, props.opacity, false);
      } catch (error) {
        logger.error('Failed to load raster image', {
          label: 'OverlayRenderer',
          imagePath: props.imagePath,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }

    return null;
  }

  /**
   * Escape XML special characters for SVG text
   */
  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Render mapped icon element
   * Displays icons based on context field values with configurable layout
   */
  private async renderMappedIconElement(
    element: OverlayElement,
    posterWidth: number,
    posterHeight: number,
    templateWidth: number,
    templateHeight: number,
    context: OverlayRenderContext
  ): Promise<Buffer | null> {
    const props = element.properties as OverlayMappedIconElementProps;

    // Get field value from context
    const fieldValue = context[props.field];
    if (fieldValue === undefined || fieldValue === null) {
      return null; // No value, skip rendering
    }

    // Normalize to array (handles both single values and arrays)
    const values: string[] = Array.isArray(fieldValue)
      ? fieldValue.map(String)
      : [String(fieldValue)];

    // Match values against mappings (case-insensitive)
    // Element mappings are snapshotted into the template JSON when the
    // element is saved, so they go stale when the default mappings gain new
    // entries (e.g. TMDB network 2552 is named "Apple TV" while the icon
    // file is "Apple TV+.png"). For values the snapshot doesn't cover, fall
    // back to the current merged mappings (user overrides, else defaults) so
    // existing elements pick up mapping fixes without a manual re-save.
    const matchedMappings: { value: string; iconPath: string }[] = [];
    let currentMappings: IconMapping[] | null = null;
    for (const value of values) {
      let mapping = props.mappings.find(
        (m) => m.value.toLowerCase() === value.toLowerCase()
      );
      if (!mapping) {
        currentMappings ??= getMergedMappings(props.field);
        mapping = currentMappings.find(
          (m) => m.value.toLowerCase() === value.toLowerCase()
        );
      }
      if (mapping) {
        matchedMappings.push(mapping);
      }
    }

    // Apply maxIcons limit if specified
    const maxIcons =
      props.maxIcons && props.maxIcons > 0
        ? props.maxIcons
        : matchedMappings.length;
    const iconsToRender = matchedMappings.slice(0, maxIcons);

    // If no icons to render, return null
    if (iconsToRender.length === 0) {
      return null;
    }

    // Calculate uniform scale factor for poster
    const posterScaleX = posterWidth / templateWidth;
    const posterScaleY = posterHeight / templateHeight;
    const posterScale = Math.min(posterScaleX, posterScaleY);

    // Scale icon size and spacing to poster size
    // Support both new spacingX/spacingY and legacy spacing field
    const iconSize = Math.round(props.iconSize * posterScale);
    const spacingX = Math.round(
      (props.spacingX ?? props.spacing ?? 4) * posterScale
    );
    const spacingY = Math.round(
      (props.spacingY ?? props.spacing ?? 4) * posterScale
    );

    // Calculate positions based on layout
    const positions = this.calculateIconPositions(
      iconsToRender.length,
      iconSize,
      spacingX,
      spacingY,
      props.layout,
      props.gridColumns || 3
    );

    // Calculate canvas size to fit all icons (auto-size to content)
    const { width: totalWidth, height: totalHeight } = mappedIconContentSize(
      iconsToRender.length,
      iconSize,
      spacingX,
      spacingY,
      props.layout,
      props.gridColumns || 3
    );

    // Load all icons and composite them
    const iconBuffers: { buffer: Buffer; x: number; y: number }[] = [];

    for (let i = 0; i < iconsToRender.length; i++) {
      const mapping = iconsToRender[i];
      const position = positions[i];

      try {
        let iconBuffer: Buffer;

        // Check if it's an API icon path or a static asset path
        const apiMatch = mapping.iconPath.match(
          /\/api\/v1\/posters\/icons\/(\w+)\/(.+)/
        );
        const assetMatch = mapping.iconPath.match(/\/assets\/(.+)/);

        if (apiMatch) {
          // Load from icon manager (user/system icons)
          const [, iconType, filename] = apiMatch;
          const { loadIconFile } = await import('@server/lib/iconManager');
          iconBuffer = await loadIconFile(
            filename,
            iconType as 'user' | 'system'
          );
        } else if (assetMatch) {
          // Load from public assets directory
          const assetPath = path.join(
            process.cwd(),
            'public',
            'assets',
            assetMatch[1]
          );
          iconBuffer = await fs.promises.readFile(assetPath);
        } else {
          logger.warn('Icon path does not match expected format', {
            label: 'OverlayRenderer',
            iconPath: mapping.iconPath,
          });
          continue;
        }

        // Get original dimensions to preserve aspect ratio
        const metadata = await sharp(iconBuffer).metadata();
        const originalWidth = metadata.width || iconSize;
        const originalHeight = metadata.height || iconSize;
        const aspectRatio = originalWidth / originalHeight;

        // Calculate dimensions that fit within iconSize while preserving aspect ratio
        let targetWidth = iconSize;
        let targetHeight = iconSize;

        if (aspectRatio > 1) {
          // Wider than tall - fit to width
          targetHeight = Math.round(iconSize / aspectRatio);
        } else if (aspectRatio < 1) {
          // Taller than wide - fit to height
          targetWidth = Math.round(iconSize * aspectRatio);
        }

        // Resize icon preserving aspect ratio
        iconBuffer = await sharp(iconBuffer)
          .resize(targetWidth, targetHeight, {
            fit: 'fill',
          })
          .png()
          .toBuffer();

        // Apply grayscale if specified
        if (props.grayscale) {
          iconBuffer = await sharp(iconBuffer).grayscale().png().toBuffer();
        }

        // Center icon within its iconSize cell
        const offsetX = Math.round((iconSize - targetWidth) / 2);
        const offsetY = Math.round((iconSize - targetHeight) / 2);

        iconBuffers.push({
          buffer: iconBuffer,
          x: position.x + offsetX,
          y: position.y + offsetY,
        });
      } catch (error) {
        logger.error('Failed to load icon for mapped-icon element', {
          label: 'OverlayRenderer',
          iconPath: mapping.iconPath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // If no icons were loaded successfully, return null
    if (iconBuffers.length === 0) {
      return null;
    }

    // Create a transparent canvas and composite all icons
    const compositeInputs: OverlayOptions[] = iconBuffers.map(
      ({ buffer, x, y }) => ({
        input: buffer,
        left: x,
        top: y,
      })
    );

    // Create base canvas with transparent background
    const result = await sharp({
      create: {
        width: totalWidth,
        height: totalHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(compositeInputs)
      .png()
      .toBuffer();

    return await applyOpacityAndGrayscale(result, props.opacity, false);
  }

  /**
   * Calculate icon positions based on layout type
   */
  private calculateIconPositions(
    count: number,
    iconSize: number,
    spacingX: number,
    spacingY: number,
    layout: 'horizontal' | 'vertical' | 'grid',
    gridColumns: number
  ): { x: number; y: number }[] {
    const positions: { x: number; y: number }[] = [];

    for (let i = 0; i < count; i++) {
      let x = 0;
      let y = 0;

      switch (layout) {
        case 'horizontal':
          x = i * (iconSize + spacingX);
          y = 0;
          break;
        case 'vertical':
          x = 0;
          y = i * (iconSize + spacingY);
          break;
        case 'grid': {
          const col = i % gridColumns;
          const row = Math.floor(i / gridColumns);
          x = col * (iconSize + spacingX);
          y = row * (iconSize + spacingY);
          break;
        }
      }

      positions.push({ x, y });
    }

    return positions;
  }
}

export const overlayTemplateRenderer = new OverlayTemplateRendererService();
