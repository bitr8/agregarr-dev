import type { IconMapping } from '@server/entity/OverlayTemplate';
import { AUDIO_PROFILE_RANK } from '@server/utils/mediaCapabilities';
import fs from 'fs';
import path from 'path';

/**
 * Default icon mappings for each field type.
 * These are the system defaults that ship with the app.
 * Users can override these with their own mappings.
 */

// Base path for default mapped icons (served from /assets/mapped-icons/)
const MAPPED_ICONS_BASE = '/assets/mapped-icons';

/**
 * Get all available flag codes from the flags directory
 */
function getAvailableFlagCodes(): string[] {
  try {
    const flagsDir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'flags'
    );
    if (!fs.existsSync(flagsDir)) {
      return [];
    }
    const files = fs.readdirSync(flagsDir);
    return files
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.replace('.svg', ''));
  } catch {
    return [];
  }
}

/**
 * Get all available language codes from the languages directory
 */
function getAvailableLanguageCodes(): string[] {
  try {
    const languagesDir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'languages'
    );
    if (!fs.existsSync(languagesDir)) {
      return [];
    }
    const files = fs.readdirSync(languagesDir);
    return files
      .filter((f) => f.endsWith('.svg'))
      .map((f) => f.replace('.svg', ''));
  } catch {
    return [];
  }
}

let _cachedNetworks: string[] | null = null;

/**
 * Get all available network names from the networks directory.
 * Result is cached for process lifetime (icons are static assets).
 */
export function getAvailableNetworks(): string[] {
  if (_cachedNetworks !== null) return _cachedNetworks;
  try {
    const networksDir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'networks'
    );
    if (!fs.existsSync(networksDir)) {
      _cachedNetworks = [];
      return [];
    }
    const files = fs.readdirSync(networksDir);
    _cachedNetworks = files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace('.png', ''));
    return _cachedNetworks;
  } catch {
    return [];
  }
}

/**
 * Get all available studio names
 */
function getAvailableStudios(): string[] {
  try {
    const dir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'studios'
    );
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace('.png', ''));
  } catch {
    return [];
  }
}

/**
 * Get all available resolution names
 */
function getAvailableResolutions(): string[] {
  try {
    const dir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'resolution'
    );
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace('.png', ''));
  } catch {
    return [];
  }
}

/**
 * Get all available audio codec names
 */
function getAvailableAudioCodecs(): string[] {
  try {
    const dir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'audio-codec'
    );
    if (!fs.existsSync(dir)) {
      return [];
    }
    const files = fs.readdirSync(dir);
    return files
      .filter((f) => f.endsWith('.png'))
      .map((f) => f.replace('.png', ''));
  } catch {
    return [];
  }
}

/**
 * Build country flag mappings
 * Maps ISO 3166-1 alpha-2 country codes to flag icons
 * Since TMDB returns country codes like "US", "GB", "DE" and our flags are named
 * the same way (US.svg, GB.svg, DE.svg), this is a direct mapping
 */
function buildCountryFlagMappings(): IconMapping[] {
  const flagCodes = getAvailableFlagCodes();
  return flagCodes.map((code) => ({
    value: code, // ISO country code (e.g., "US", "GB", "DE")
    iconPath: `${MAPPED_ICONS_BASE}/flags/${code}.svg`,
  }));
}

/**
 * Build language code mappings
 * Maps ISO 639-1 language codes to language icons
 * Plex/TMDB uses lowercase codes like "en", "de", "fr"
 */
function buildLanguageMappings(): IconMapping[] {
  const languageCodes = getAvailableLanguageCodes();
  return languageCodes.map((code) => ({
    value: code, // ISO 639-1 language code (e.g., "en", "de", "fr")
    iconPath: `${MAPPED_ICONS_BASE}/languages/${code}.svg`,
  }));
}

/**
 * Build network mappings
 * Maps TV network names to network logo icons
 * TMDB network names don't always match icon filenames (e.g. network 2552 is
 * named "Apple TV" but the icon file is "Apple TV+.png"), so alias entries
 * from TMDB_NAME_TO_ICON_ALIAS are added alongside the direct name matches.
 */
function buildNetworkMappings(): IconMapping[] {
  const networks = getAvailableNetworks();
  const availableIcons = new Set(networks.map((n) => n.toLowerCase()));

  // Start with all available network icons as direct name matches
  const mappings: IconMapping[] = networks.map((network) => ({
    value: network, // Network name (e.g., "HBO", "Netflix", "ABC")
    iconPath: `${MAPPED_ICONS_BASE}/networks/${network}.png`,
  }));

  // Add TMDB name aliases that map to different icon filenames
  for (const [tmdbName, iconName] of Object.entries(TMDB_NAME_TO_ICON_ALIAS)) {
    if (availableIcons.has(iconName.toLowerCase())) {
      const match = networks.find(
        (n) => n.toLowerCase() === iconName.toLowerCase()
      );
      mappings.push({
        value: tmdbName,
        iconPath: `${MAPPED_ICONS_BASE}/networks/${match ?? iconName}.png`,
      });
    }
  }

  return mappings;
}

// TMDB provider ID → icon filename. Covers major worldwide streaming services.
// Only IDs whose icon file exists are included (checked at build time).
const STREAMING_PROVIDER_ID_TO_ICON: Record<string, string> = {
  // Netflix
  '8': 'Netflix',
  '1796': 'Netflix',
  // Disney+
  '337': 'Disney+',
  '390': 'Disney+',
  // Amazon Prime Video
  '9': 'Prime Video',
  '119': 'Prime Video',
  // Apple TV+
  '350': 'Apple TV+',
  // Max / HBO
  '1899': 'Max',
  '384': 'Max',
  // Hulu
  '15': 'Hulu',
  // Peacock
  '386': 'Peacock',
  '387': 'Peacock',
  // Paramount+
  '531': 'Paramount+',
  '582': 'Paramount+',
  '2303': 'Paramount+',
  '2616': 'Paramount+',
  // Crunchyroll
  '283': 'Crunchyroll',
  // Starz / Showtime / AMC+ / MGM+
  '43': 'Starz',
  '37': 'Showtime',
  '526': 'AMC+',
  '528': 'AMC+',
  '1770': 'MGM+',
  // discovery+ / BritBox / Freevee / Shudder
  '584': 'discovery+',
  '151': 'BritBox',
  '636': 'BritBox',
  '613': 'Freevee',
  '99': 'Shudder',
  // Criterion / Acorn / Curiosity Stream
  '258': 'Criterion Channel',
  '87': 'Acorn TV',
  '190': 'Curiosity Stream',
  // Regional: AU
  '21': 'Stan',
  '385': 'Binge',
  // Regional: CA
  '30': 'Crave',
  // Regional: UK
  '38': 'BBC iPlayer',
  '41': 'ITVX',
  // Regional: Other
  '76': 'Viaplay',
  '307': 'Globoplay',
  '220': 'JioCinema',
  '236': 'Shahid',
  '619': 'STAR+',
  '97': 'tving',
  '232': 'ZEE5',
  '581': 'iQiyi',
  // Misc
  '318': 'Adult Swim',
  '73': 'tubi',
  '207': 'The Roku Channel',
  '444': 'Lionsgate+',
  '55': 'Showmax',
  '457': 'ViX+',
  '428': 'ViX',
  '192': 'YouTube',
  '188': 'YouTube',
  '29': 'Sky',
  '381': 'Canal+',
  '300': 'Crackle',
  '175': 'Quibi',
  '247': 'Pantaya',
  '1875': 'BET+',
  '11': 'Cinemax',
};

function buildStreamingProviderIdMappings(): IconMapping[] {
  const networks = getAvailableNetworks();
  const availableIcons = new Set(networks.map((n) => n.toLowerCase()));
  return Object.entries(STREAMING_PROVIDER_ID_TO_ICON)
    .filter(([, iconName]) => availableIcons.has(iconName.toLowerCase()))
    .map(([id, iconName]) => {
      const match = networks.find(
        (n) => n.toLowerCase() === iconName.toLowerCase()
      );
      return {
        value: id,
        iconPath: `${MAPPED_ICONS_BASE}/networks/${match ?? iconName}.png`,
      };
    });
}

// TMDB provider names that don't match icon filenames exactly
const TMDB_NAME_TO_ICON_ALIAS: Record<string, string> = {
  'Disney Plus': 'Disney+',
  'Amazon Prime Video': 'Prime Video',
  'Amazon Video': 'Prime Video',
  'Netflix basic with Ads': 'Netflix',
  'Netflix Standard with Ads': 'Netflix',
  'Netflix ads': 'Netflix',
  'HBO Max': 'Max',
  'Peacock Premium': 'Peacock',
  'Peacock Premium Plus': 'Peacock',
  'Paramount Plus': 'Paramount+',
  'Paramount Plus Premium': 'Paramount+',
  'Paramount Plus Essential': 'Paramount+',
  'Paramount+ with Showtime': 'Paramount+',
  'Paramount+ Amazon Channel': 'Paramount+',
  'Apple TV': 'Apple TV+',
  'Apple TV Plus': 'Apple TV+',
  'HBO Now': 'HBO',
  'HBO Go': 'HBO',
  'Max Amazon Channel': 'Max',
  'discovery+ Amazon Channel': 'discovery+',
  'Discovery Plus': 'discovery+',
  'BritBox Amazon Channel': 'BritBox',
  'AMC Plus': 'AMC+',
  'AMC+ Amazon Channel': 'AMC+',
  'MGM Plus': 'MGM+',
  'Starz Amazon Channel': 'Starz',
  'Showtime Amazon Channel': 'Showtime',
  'BET Plus': 'BET+',
  'Lionsgate Plus': 'Lionsgate+',
};

// Case-insensitive version built once at module load
const TMDB_NAME_TO_ICON_ALIAS_LOWER = new Map(
  Object.entries(TMDB_NAME_TO_ICON_ALIAS).map(([k, v]) => [k.toLowerCase(), v])
);

function buildStreamingProviderNameMappings(): IconMapping[] {
  const networks = getAvailableNetworks();
  const availableIcons = new Set(networks.map((n) => n.toLowerCase()));

  // Start with all available network icons as direct name matches
  const mappings: IconMapping[] = networks.map((network) => ({
    value: network,
    iconPath: `${MAPPED_ICONS_BASE}/networks/${network}.png`,
  }));

  // Add TMDB name aliases that map to different icon filenames
  for (const [tmdbName, iconName] of Object.entries(TMDB_NAME_TO_ICON_ALIAS)) {
    if (availableIcons.has(iconName.toLowerCase())) {
      const match = networks.find(
        (n) => n.toLowerCase() === iconName.toLowerCase()
      );
      mappings.push({
        value: tmdbName,
        iconPath: `${MAPPED_ICONS_BASE}/networks/${match ?? iconName}.png`,
      });
    }
  }

  return mappings;
}

/**
 * Build studio mappings
 */
function buildStudioMappings(): IconMapping[] {
  const studios = getAvailableStudios();
  return studios.map((studio) => ({
    value: studio,
    iconPath: `${MAPPED_ICONS_BASE}/studios/${studio}.png`,
  }));
}

/**
 * Build resolution mappings
 */
function buildResolutionMappings(): IconMapping[] {
  const resolutions = getAvailableResolutions();
  return resolutions.map((res) => ({
    value: res,
    iconPath: `${MAPPED_ICONS_BASE}/resolution/${res}.png`,
  }));
}

// audioCodec values that differ from the icon filenames (Plex Media-level
// names, plus the editor's legacy 'dts' sample value)
const AUDIO_CODEC_ALIASES: Record<string, string> = {
  ac3: 'digital',
  eac3: 'plus',
  'dca-ma': 'ma',
  dts: 'dca',
};

/**
 * Build audio codec mappings
 */
function buildAudioCodecMappings(): IconMapping[] {
  const codecs = getAvailableAudioCodecs();
  const identity = codecs.map((codec) => ({
    value: codec,
    iconPath: `${MAPPED_ICONS_BASE}/audio-codec/${codec}.png`,
  }));
  const aliases = Object.entries(AUDIO_CODEC_ALIASES)
    .filter(([, icon]) => codecs.includes(icon))
    .map(([value, icon]) => ({
      value,
      iconPath: `${MAPPED_ICONS_BASE}/audio-codec/${icon}.png`,
    }));
  return [...identity, ...aliases];
}

/**
 * Build audio profile mappings — only tokens detectAudioProfile can emit
 */
function buildAudioProfileMappings(): IconMapping[] {
  const icons = getAvailableAudioCodecs();
  return AUDIO_PROFILE_RANK.filter((token) => icons.includes(token)).map(
    (token) => ({
      value: token,
      iconPath: `${MAPPED_ICONS_BASE}/audio-codec/${token}.png`,
    })
  );
}

/**
 * Get available country directories under content-ratings
 */
export function getAvailableContentRatingCountries(): string[] {
  try {
    const dir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'content-ratings'
    );
    if (!fs.existsSync(dir)) {
      return [];
    }
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

const _cachedContentRatingMappings = new Map<string, IconMapping[]>();

/**
 * Build content rating mappings for a specific country.
 * Scans /public/assets/mapped-icons/content-ratings/{country}/ for icon files.
 * Result is cached per country for process lifetime (icons are static assets) —
 * called from getMergedMappings() on the overlay render/hash hot path.
 */
function buildContentRatingMappings(country: string): IconMapping[] {
  const cached = _cachedContentRatingMappings.get(country);
  if (cached) return cached;

  try {
    const dir = path.join(
      process.cwd(),
      'public',
      'assets',
      'mapped-icons',
      'content-ratings',
      country
    );
    if (!fs.existsSync(dir)) {
      _cachedContentRatingMappings.set(country, []);
      return [];
    }
    const files = fs.readdirSync(dir);
    const mappings = files
      .filter((f) => f.endsWith('.png') || f.endsWith('.svg'))
      .map((f) => ({
        value: f.replace(/\.(png|svg)$/, ''),
        iconPath: `${MAPPED_ICONS_BASE}/content-ratings/${country}/${f}`,
      }));
    _cachedContentRatingMappings.set(country, mappings);
    return mappings;
  } catch {
    return [];
  }
}

/**
 * Default mappings registry - organized by field name
 */
const DEFAULT_MAPPINGS: Record<string, IconMapping[]> = {
  // Country fields - use flag icons
  originCountry: buildCountryFlagMappings(),
  originCountries: buildCountryFlagMappings(),
  productionCountry: buildCountryFlagMappings(),
  productionCountries: buildCountryFlagMappings(),

  // Language fields - use language code icons (maps ISO 639-1 codes like "en", "de")
  audioLanguageCode: buildLanguageMappings(),
  audioLanguageCodes: buildLanguageMappings(),
  subtitleLanguageCodes: buildLanguageMappings(),

  // Network field - TV network logos
  network: buildNetworkMappings(),

  // Streaming provider fields
  streamingProvider: buildStreamingProviderNameMappings(),
  streamingProviderId: buildStreamingProviderIdMappings(),

  // Studio field - Movie/TV studio logos
  studio: buildStudioMappings(),

  // Resolution mappings
  resolution: buildResolutionMappings(),

  // Audio codec mappings
  audioCodec: buildAudioCodecMappings(),

  // Audio profile tokens (detectAudioProfile) — same icon set
  audioProfile: buildAudioProfileMappings(),
};

/**
 * Get default mappings for a specific field
 * Handles dynamic contentRating:{country} fields
 */
export function getDefaultMappings(field: string): IconMapping[] {
  // Check static mappings first
  if (DEFAULT_MAPPINGS[field]) {
    return DEFAULT_MAPPINGS[field];
  }

  // Handle contentRating:{country} dynamically
  const contentRatingMatch = field.match(/^contentRating:(.+)$/);
  if (contentRatingMatch) {
    return buildContentRatingMappings(contentRatingMatch[1]);
  }

  return [];
}

/**
 * Get all fields that have default mappings
 */
export function getFieldsWithDefaults(): string[] {
  const staticFields = Object.keys(DEFAULT_MAPPINGS).filter(
    (key) => DEFAULT_MAPPINGS[key].length > 0
  );

  // Add content rating country fields
  const countries = getAvailableContentRatingCountries();
  const contentRatingFields = countries
    .filter((country) => buildContentRatingMappings(country).length > 0)
    .map((country) => `contentRating:${country}`);

  return [...staticFields, ...contentRatingFields];
}

/**
 * Check if a streaming provider has a matching icon by name or ID.
 * Used by OverlayContextBuilder to skip providers we can't display.
 */
export function hasStreamingProviderIcon(
  providerName: string,
  providerId: number
): boolean {
  const available = getAvailableNetworks();
  const lowerSet = new Set(available.map((n) => n.toLowerCase()));

  const idStr = String(providerId);
  const idIcon = STREAMING_PROVIDER_ID_TO_ICON[idStr];
  if (idIcon && lowerSet.has(idIcon.toLowerCase())) {
    return true;
  }

  if (lowerSet.has(providerName.toLowerCase())) {
    return true;
  }

  const alias = TMDB_NAME_TO_ICON_ALIAS_LOWER.get(providerName.toLowerCase());
  if (alias && lowerSet.has(alias.toLowerCase())) {
    return true;
  }

  return false;
}

/**
 * Check if a field has default mappings available
 */
export function hasDefaultMappings(field: string): boolean {
  if ((DEFAULT_MAPPINGS[field]?.length || 0) > 0) {
    return true;
  }

  // Handle contentRating:{country} dynamically
  const contentRatingMatch = field.match(/^contentRating:(.+)$/);
  if (contentRatingMatch) {
    return buildContentRatingMappings(contentRatingMatch[1]).length > 0;
  }

  return false;
}
