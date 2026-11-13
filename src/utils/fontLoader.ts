// Font preloader utility following Fabric.js recommendations
interface FontInfo {
  family: string;
  fontUrl: string;
}

// Where librsvg puts dominant-baseline="middle": strikeout position + half its size, in ems
export function readMiddleBaseline(buffer: ArrayBuffer): number | undefined {
  try {
    const view = new DataView(buffer);
    const numTables = view.getUint16(4);
    let head = -1;
    let os2 = -1;
    for (let i = 0; i < numTables; i++) {
      const rec = 12 + i * 16;
      const tag = String.fromCharCode(
        view.getUint8(rec),
        view.getUint8(rec + 1),
        view.getUint8(rec + 2),
        view.getUint8(rec + 3)
      );
      if (tag === 'head') head = view.getUint32(rec + 8);
      if (tag === 'OS/2') os2 = view.getUint32(rec + 8);
    }
    if (head < 0 || os2 < 0) return undefined;
    const unitsPerEm = view.getUint16(head + 18);
    const strikeoutSize = view.getInt16(os2 + 26);
    const strikeoutPosition = view.getInt16(os2 + 28);
    if (!unitsPerEm || strikeoutPosition <= 0 || strikeoutPosition > unitsPerEm)
      return undefined;
    return (strikeoutPosition + strikeoutSize / 2) / unitsPerEm;
  } catch {
    return undefined;
  }
}

class FontLoader {
  private loadedFonts = new Set<string>();
  private middleBaselines = new Map<string, number>();
  private fontPromises = new Map<string, Promise<void>>();

  /**
   * Load a single font using @font-face and Font Loading API
   */
  async loadFont(fontInfo: FontInfo): Promise<void> {
    const { family, fontUrl } = fontInfo;

    // Return existing promise if font is already being loaded
    if (this.fontPromises.has(family)) {
      const existingPromise = this.fontPromises.get(family);
      if (existingPromise) {
        return existingPromise;
      }
    }

    // Return immediately if font is already loaded
    if (this.loadedFonts.has(family)) {
      return Promise.resolve();
    }

    const promise = this.loadFontInternal(family, fontUrl);
    this.fontPromises.set(family, promise);
    return promise;
  }

  private async loadFontInternal(
    family: string,
    fontUrl: string
  ): Promise<void> {
    const response = await fetch(fontUrl);
    if (!response.ok) throw new Error(`Font fetch failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    const middle = readMiddleBaseline(buffer);
    if (middle !== undefined) this.middleBaselines.set(family, middle);

    const fontFace = new FontFace(family, buffer);

    // Load the font
    await fontFace.load();

    // Add to document fonts
    document.fonts.add(fontFace);

    // Mark as loaded
    this.loadedFonts.add(family);
  }

  /**
   * Load multiple fonts in parallel
   */
  async loadFonts(fonts: FontInfo[]): Promise<void> {
    const promises = fonts.map((font) => this.loadFont(font));
    await Promise.all(promises);
  }

  /**
   * Check if a font is loaded
   */
  isFontLoaded(family: string): boolean {
    return this.loadedFonts.has(family);
  }

  getMiddleBaseline(family: string): number | undefined {
    return this.middleBaselines.get(family);
  }

  /**
   * Wait for a specific font to be available (with timeout)
   */
  async waitForFont(family: string, timeout = 3000): Promise<boolean> {
    if (this.loadedFonts.has(family)) {
      return true;
    }

    return new Promise((resolve) => {
      const startTime = Date.now();

      const checkFont = () => {
        if (this.loadedFonts.has(family)) {
          resolve(true);
        } else if (Date.now() - startTime > timeout) {
          resolve(false);
        } else {
          requestAnimationFrame(checkFont);
        }
      };

      checkFont();
    });
  }
}

// Export singleton instance
export const fontLoader = new FontLoader();
