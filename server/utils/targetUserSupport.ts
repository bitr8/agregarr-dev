export const supportsTargetUser = (
  type?: string,
  subtype?: string
): boolean => {
  if (type === 'overseerr') return false;
  if (type === 'tmdb' && subtype === 'auto_franchise') return false;
  if (type === 'plex' && subtype !== 'label') return false;
  return true;
};

export const withoutTargetUser = <T extends object>(config: T): T => {
  const copy = { ...config } as Record<string, unknown>;
  delete copy.targetUserId;
  delete copy.targetUserLabel;
  return copy as T;
};

export const withSupportedTargetUser = <
  T extends { type?: string; subtype?: string }
>(
  config: T
): T =>
  supportsTargetUser(config.type, config.subtype)
    ? config
    : withoutTargetUser(config);

export const targetedConfigs = <
  T extends { type?: string; subtype?: string; targetUserId?: unknown }
>(
  configs: T[]
): T[] =>
  configs.filter(
    (config) =>
      config.targetUserId !== undefined &&
      supportsTargetUser(config.type, config.subtype)
  );
