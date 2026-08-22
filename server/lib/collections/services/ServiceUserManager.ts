import OverseerrAPI, { type OverseerrUser } from '@server/api/overseerr';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { AxiosError } from 'axios';
import { randomUUID } from 'crypto';

// Bits that decide Overseerr/Jellyseerr auto-approval (both check generic OR type-specific bits, MediaRequest.ts); Agregarr must own all of them. REQUEST_4K stays external-owned.
const APPROVAL_DECIDING_BITS = 32 | 128 | 256 | 512;

/** GET 404 on an external user's permissions — the externalOverseerrId is stale. */
class StaleExternalOverseerrUserError extends Error {}

/**
 * Extract error details from axios errors or regular errors for logging
 */
function getErrorDetails(error: unknown): {
  status?: number;
  data?: unknown;
  message: string;
  stack?: string;
} {
  if (error instanceof AxiosError) {
    return {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
      stack: error.stack,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    message: String(error),
  };
}

/**
 * Configuration for creating service users
 */
export interface ServiceUserConfig {
  username: string;
  displayName: string;
  email: string;
  permissions: number;
  avatar?: string;
  description?: string;
}

/**
 * Service types for user creation
 */
export type ServiceType =
  | 'trakt'
  | 'tmdb'
  | 'imdb'
  | 'mdblist'
  | 'letterboxd'
  | 'networks'
  | 'originals'
  | 'tautulli'
  | 'overseerr'
  | 'anilist'
  | 'myanimelist'
  | 'multi-source';

/**
 * Generate service user configuration dynamically
 */
export function generateServiceUserConfig(
  serviceType: ServiceType,
  collectionType?: string,
  userCreationMode: 'single' | 'per-service' | 'granular' = 'per-service'
): ServiceUserConfig {
  const serviceInfo = {
    trakt: { name: 'Trakt' },
    tmdb: { name: 'TMDB' },
    imdb: { name: 'IMDb' },
    mdblist: { name: 'MDBList' },
    letterboxd: { name: 'Letterboxd' },
    networks: { name: 'Networks' },
    originals: { name: 'Originals' },
    tautulli: { name: 'Tautulli' },
    overseerr: { name: 'Overseerr' },
    anilist: { name: 'AniList' },
    myanimelist: { name: 'MyAnimeList' },
    'multi-source': { name: 'MultiSource' },
  }[serviceType];

  let username: string;
  let displayName: string;
  let email: string;
  let avatar: string;
  let description: string;

  switch (userCreationMode) {
    case 'single':
      // Single mode: Everything goes to "Agregarr"
      username = 'Agregarr';
      displayName = 'Agregarr';
      email = 'donotchangeme@agregarr.invalid';
      avatar = '/os_icon.svg';
      description = 'Virtual service user for all Agregarr collection requests';
      break;

    case 'granular':
      if (collectionType) {
        // Granular mode: TraktTrendingAgregarr, TMDbPopularAgregarr, etc.
        const collectionName =
          collectionType.charAt(0).toUpperCase() + collectionType.slice(1);
        username = `${serviceInfo.name}${collectionName}Agregarr`;
        displayName = username;
        email = `donotchangeme@${serviceType.toLowerCase()}.${collectionType.toLowerCase()}.agregarr.invalid`;
        avatar = '/os_icon.svg';
        description = `Virtual service user for ${serviceInfo.name} ${collectionName} collection requests`;
      } else {
        // Fallback to per-service if no collection type
        username = `${serviceInfo.name}Agregarr`;
        displayName = username;
        email = `donotchangeme@${serviceType.toLowerCase()}.agregarr.invalid`;
        avatar = '/os_icon.svg';
        description = `Virtual service user for ${serviceInfo.name} collection requests`;
      }
      break;

    case 'per-service':
    default:
      // Per-service mode: TraktAgregarr, TMDbAgregarr, etc.
      username = `${serviceInfo.name}Agregarr`;
      displayName = username;
      email = `donotchangeme@${serviceType.toLowerCase()}.agregarr.invalid`;
      avatar = '/os_icon.svg';
      description = `Virtual service user for ${serviceInfo.name} collection requests`;
      break;
  }

  return {
    username,
    displayName,
    email,
    permissions: 32, // Start with manual approval permissions (will be changed dynamically)
    avatar,
    description,
  };
}

/**
 * Service User Manager for creating and managing virtual users
 *
 * Handles creation, retrieval, and management of service users used by
 * collection sync processes for auto-requests and other automated operations.
 */
export class ServiceUserManager {
  private userRepository = getRepository(User);

  /**
   * Get Overseerr API client with current settings
   */
  private getOverseerrAPI(): OverseerrAPI {
    const settings = getSettings();
    if (!settings.overseerr.hostname || !settings.overseerr.apiKey) {
      throw new Error(
        'External Overseerr not configured for service user management'
      );
    }
    // Create fresh client with current settings
    return new OverseerrAPI(settings.overseerr);
  }

  /**
   * Get or create a service user based on configuration
   *
   * @param config - Service user configuration
   * @returns Promise resolving to the service user
   */
  public async getOrCreateServiceUser(
    config: ServiceUserConfig
  ): Promise<User> {
    // Try to find existing service user by email (unique identifier)
    let serviceUser = await this.userRepository.findOne({
      where: { email: config.email },
    });

    // If not found with new format, try old format (migration path)
    if (!serviceUser && config.email.endsWith('.invalid')) {
      const oldEmail = config.email.replace('.invalid', '');
      serviceUser = await this.userRepository.findOne({
        where: { email: oldEmail },
      });

      // Migrate to new email format
      if (serviceUser) {
        logger.info(
          `Migrating service user email from old format: ${oldEmail} → ${config.email}`,
          {
            label: 'Service User Manager',
            username: config.username,
          }
        );

        // Update internal user email
        serviceUser.email = config.email;
        serviceUser.updatedAt = new Date();

        // Recreate external Overseerr user with new email (email is read-only, can't be updated)
        if (serviceUser.externalOverseerrId) {
          try {
            const overseerrAPI = this.getOverseerrAPI();

            // Create new external user with correct email
            const password = this.generateSecurePassword();
            const newExternalUser = await overseerrAPI.createUser({
              username: config.username,
              email: config.email,
              password: password,
              displayName: config.displayName,
            });

            // Set appropriate permissions
            await this.pushOverseerrPermissions(
              overseerrAPI,
              newExternalUser.id,
              config.permissions,
              newExternalUser.permissions
            );
            await overseerrAPI.disableUserNotifications(newExternalUser.id);

            logger.info(
              `Recreated external Overseerr user with new email for: ${config.displayName}`,
              {
                label: 'Service User Manager',
                oldExternalUserId: serviceUser.externalOverseerrId,
                newExternalUserId: newExternalUser.id,
                oldEmail: oldEmail,
                newEmail: config.email,
              }
            );

            // Update internal user to point to new external user
            serviceUser.externalOverseerrId = newExternalUser.id;
          } catch (error) {
            logger.warn(
              `Failed to recreate external Overseerr user for ${config.displayName}, will retry on next sync`,
              {
                label: 'Service User Manager',
                externalUserId: serviceUser.externalOverseerrId,
                error: error instanceof Error ? error.message : String(error),
              }
            );
          }
        }

        await this.userRepository.save(serviceUser);
      }
    }

    if (!serviceUser) {
      // Create new service user (both internal and external)
      serviceUser = await this.createServiceUser(config);

      logger.info(`Created virtual service user: ${config.displayName}`, {
        label: 'Service User Manager',
        username: config.username,
        email: config.email,
        permissions: config.permissions,
        externalOverseerrId: serviceUser.externalOverseerrId,
      });
    } else {
      // Ensure user exists in external Overseerr and has correct permissions
      await this.ensureExternalUser(serviceUser, config);

      // Update existing service user if permissions have changed
      const hasPermissionChanges =
        serviceUser.permissions !== config.permissions;
      const hasDisplayNameChanges =
        serviceUser.displayName !== config.displayName;

      if (hasPermissionChanges || hasDisplayNameChanges) {
        serviceUser.permissions = config.permissions;
        serviceUser.displayName = config.displayName;
        serviceUser.updatedAt = new Date();

        await this.userRepository.save(serviceUser);

        // Also update permissions in external Overseerr if they changed
        if (hasPermissionChanges && serviceUser.externalOverseerrId) {
          try {
            const overseerrAPI = this.getOverseerrAPI();
            await this.pushOverseerrPermissions(
              overseerrAPI,
              serviceUser.externalOverseerrId,
              config.permissions
            );
            await overseerrAPI.disableUserNotifications(
              serviceUser.externalOverseerrId
            );

            logger.info(
              `Updated external Overseerr permissions for: ${config.displayName}`,
              {
                label: 'Service User Manager',
                externalUserId: serviceUser.externalOverseerrId,
              }
            );
          } catch (error) {
            // If permission update fails (likely due to stale user ID), re-ensure external user
            logger.warn(
              `Permission update failed for external user ${serviceUser.externalOverseerrId}, re-ensuring user: ${config.displayName}`,
              {
                label: 'Service User Manager',
                externalUserId: serviceUser.externalOverseerrId,
                error: error instanceof Error ? error.message : String(error),
              }
            );

            // Clear stale external user ID and re-ensure external user
            // Set to undefined in memory only - will be saved by ensureExternalUser if successful
            serviceUser.externalOverseerrId = undefined;
            await this.ensureExternalUser(serviceUser, config);
            // ensureExternalUser will set the new ID and save if successful
            // If it fails, user still has undefined but that's handled by ensureExternalUser on next run
          }
        }

        logger.info(`Updated virtual service user: ${config.displayName}`, {
          label: 'Service User Manager',
          username: config.username,
          permissionsChanged: hasPermissionChanges,
          displayNameChanged: hasDisplayNameChanges,
        });
      }
    }

    return serviceUser;
  }

  /**
   * Get or create service user by type with settings consideration
   */
  public async getOrCreateServiceUserByType(
    serviceType: ServiceType,
    collectionType?: string
  ): Promise<User> {
    const settings = getSettings();
    const userCreationMode =
      settings.serviceUser?.userCreationMode ?? 'per-service';

    const config = generateServiceUserConfig(
      serviceType,
      collectionType,
      userCreationMode
    );
    return this.getOrCreateServiceUser(config);
  }

  /**
   * Get or create service user with dynamic permissions
   */
  public async getOrCreateServiceUserForRequest(
    serviceType: ServiceType,
    collectionType: string | undefined,
    autoApprove: boolean
  ): Promise<User> {
    const settings = getSettings();
    const userCreationMode =
      settings.serviceUser?.userCreationMode ?? 'per-service';

    // Generate config
    const config = generateServiceUserConfig(
      serviceType,
      collectionType,
      userCreationMode
    );

    // Override permissions based on auto-approve setting
    config.permissions = autoApprove ? 928 : 32; // 928 = auto-approve, 32 = manual

    return this.getOrCreateServiceUser(config);
  }

  // Note: Virtual user creation removed - not needed since collection functions
  // ignore user parameter when custom titles and global collection flags are used

  /**
   * Clean up orphaned service users
   *
   * Removes service users that are no longer needed or have been replaced
   * by newer configurations.
   */
  public async cleanupOrphanedServiceUsers(): Promise<number> {
    // Get all service users (emails starting with donotchangeme@)
    const allServiceUsers = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email LIKE :pattern', { pattern: 'donotchangeme@%' })
      .getMany();

    if (allServiceUsers.length === 0) {
      return 0;
    }

    // For now, don't auto-cleanup users since the new system is dynamic
    // Users should manually clean up old users after transitioning
    logger.info(`Found ${allServiceUsers.length} service users`, {
      label: 'Service User Manager',
      users: allServiceUsers.map((u) => ({
        email: u.email,
        displayName: u.displayName,
      })),
    });

    return 0; // No cleanup performed automatically
  }

  /**
   * List all active service users
   */
  public async listServiceUsers(): Promise<User[]> {
    return this.userRepository
      .createQueryBuilder('user')
      .where('user.email LIKE :pattern', { pattern: 'donotchangeme@%' })
      .getMany();
  }

  /**
   * Create a new service user (both internal and external)
   */
  private async createServiceUser(config: ServiceUserConfig): Promise<User> {
    const overseerrAPI = this.getOverseerrAPI();

    // First, check if user already exists in external Overseerr
    let externalUser = await this.findExistingUserByEmail(config.email);

    if (externalUser) {
      // User exists — fetch current permissions fresh, don't trust the batch-list snapshot
      try {
        await this.pushOverseerrPermissions(
          overseerrAPI,
          externalUser.id,
          config.permissions
        );
      } catch (error) {
        if (!(error instanceof StaleExternalOverseerrUserError)) {
          throw error;
        }

        // The batch-list match is gone from Overseerr — recreate and push against the new id, same as the primary recreate path.
        logger.warn(
          `External Overseerr user ${externalUser.id} not found, recreating: ${config.username}`,
          {
            label: 'Service User Manager',
            externalUserId: externalUser.id,
          }
        );

        const password = this.generateSecurePassword();
        externalUser = await overseerrAPI.createUser({
          username: config.username,
          email: config.email,
          password: password,
          displayName: config.displayName,
        });

        await this.pushOverseerrPermissions(
          overseerrAPI,
          externalUser.id,
          config.permissions,
          externalUser.permissions
        );
      }

      await overseerrAPI.disableUserNotifications(externalUser.id);

      logger.debug(
        `Found existing external Overseerr user: ${config.username}`,
        {
          label: 'Service User Manager',
          externalUserId: externalUser.id,
        }
      );
    } else {
      // User doesn't exist, create new one
      try {
        const password = this.generateSecurePassword();
        externalUser = await overseerrAPI.createUser({
          username: config.username,
          email: config.email,
          password: password,
          displayName: config.displayName,
        });

        // Set appropriate permissions
        await this.pushOverseerrPermissions(
          overseerrAPI,
          externalUser.id,
          config.permissions,
          externalUser.permissions
        );
        await overseerrAPI.disableUserNotifications(externalUser.id);

        logger.debug(`Created external Overseerr user: ${config.username}`, {
          label: 'Service User Manager',
          externalUserId: externalUser.id,
        });
      } catch (error) {
        const errorDetails = getErrorDetails(error);
        logger.error(
          `Failed to create external Overseerr user: ${config.username}`,
          {
            label: 'Service User Manager',
            username: config.username,
            email: config.email,
            displayName: config.displayName,
            errorStatus: errorDetails.status,
            errorData: errorDetails.data,
            errorMessage: errorDetails.message,
          }
        );
        throw new Error(`Failed to create external Overseerr user: ${error}`);
      }
    }

    // Create internal user with external ID mapping
    const serviceUser = new User({
      email: config.email,
      username: config.username,
      displayName: config.displayName,
      plexUsername: config.username,
      plexTitle: config.displayName,
      permissions: config.permissions,
      userType: 1, // LOCAL user type
      externalOverseerrId: externalUser.id,
      avatar: '/os_icon.svg', // Default Agregarr icon for service users
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    return await this.userRepository.save(serviceUser);
  }

  /**
   * Ensure user exists in external Overseerr and has correct permissions
   */
  private async ensureExternalUser(
    user: User,
    config: ServiceUserConfig
  ): Promise<void> {
    const overseerrAPI = this.getOverseerrAPI();

    if (!user.externalOverseerrId) {
      // User doesn't have external ID, check if user exists in external Overseerr
      let externalUser = await this.findExistingUserByEmail(config.email);
      let justCreated = false;

      if (externalUser) {
        // Found existing external user, link it
        user.externalOverseerrId = externalUser.id;
        await this.userRepository.save(user);

        logger.info(
          `Linked existing service user to external Overseerr: ${config.username}`,
          {
            label: 'Service User Manager',
            externalUserId: externalUser.id,
          }
        );
      } else {
        // External user doesn't exist, create it
        try {
          const password = this.generateSecurePassword();
          externalUser = await overseerrAPI.createUser({
            username: config.username,
            email: config.email,
            password: password,
            displayName: config.displayName,
          });
          justCreated = true;

          // Update internal user with external ID
          user.externalOverseerrId = externalUser.id;
          await this.userRepository.save(user);

          logger.info(
            `Created and linked external user for existing service user: ${config.username}`,
            {
              label: 'Service User Manager',
              externalUserId: externalUser.id,
            }
          );
        } catch (error) {
          const errorDetails = getErrorDetails(error);
          logger.error(
            `Failed to create external Overseerr user: ${config.username}`,
            {
              label: 'Service User Manager',
              username: config.username,
              email: config.email,
              displayName: config.displayName,
              errorStatus: errorDetails.status,
              errorData: errorDetails.data,
              errorMessage: errorDetails.message,
            }
          );
          throw new Error(
            `Failed to create external Overseerr user for ${config.username}: ${errorDetails.message}`
          );
        }
      }

      // Set appropriate permissions for the external user (new or existing)
      try {
        await this.pushOverseerrPermissions(
          overseerrAPI,
          externalUser.id,
          config.permissions,
          justCreated ? externalUser.permissions : undefined
        );
        await overseerrAPI.disableUserNotifications(externalUser.id);
      } catch (error) {
        // externalOverseerrId is already linked/saved above — rethrow so the caller skips this
        // item this sync rather than proceeding under undetermined permissions. The next sync's
        // "else" branch below self-heals (it recreates on any push failure, including this one).
        logger.error(
          `Failed to set permissions for external user: ${config.username}`,
          {
            label: 'Service User Manager',
            externalUserId: externalUser.id,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        throw error;
      }
    } else {
      // User exists externally, ensure permissions are correct
      try {
        await this.pushOverseerrPermissions(
          overseerrAPI,
          user.externalOverseerrId,
          config.permissions
        );
        await overseerrAPI.disableUserNotifications(user.externalOverseerrId);
      } catch (error) {
        // If permission update fails (likely due to stale user ID), clear and recreate
        logger.warn(
          `Permission update failed for external user ${user.externalOverseerrId}, recreating user: ${config.username}`,
          {
            label: 'Service User Manager',
            externalUserId: user.externalOverseerrId,
          }
        );

        // Try to find existing user by email first, or create new one
        let externalUser = await this.findExistingUserByEmail(config.email);

        if (!externalUser) {
          // External user doesn't exist, create it
          const password = this.generateSecurePassword();

          try {
            externalUser = await overseerrAPI.createUser({
              username: config.username,
              email: config.email,
              password: password,
              displayName: config.displayName,
            });
          } catch (createError) {
            const createErrorDetails = getErrorDetails(createError);
            logger.error(
              `Failed to recreate external Overseerr user during recovery: ${config.username}`,
              {
                label: 'Service User Manager',
                username: config.username,
                email: config.email,
                displayName: config.displayName,
                errorStatus: createErrorDetails.status,
                errorData: createErrorDetails.data,
                errorMessage: createErrorDetails.message,
              }
            );
            throw createError; // Re-throw to prevent saving undefined
          }
        }

        // Only clear and save the undefined value AFTER successfully getting a new external user
        // This prevents storing undefined permanently if the above operations fail
        user.externalOverseerrId = externalUser.id;
        await this.userRepository.save(user);

        // Set appropriate permissions for the external user
        await this.pushOverseerrPermissions(
          overseerrAPI,
          externalUser.id,
          config.permissions,
          externalUser.permissions
        );
        await overseerrAPI.disableUserNotifications(externalUser.id);
      }
    }
  }

  /**
   * Find existing user in external Overseerr by email
   */
  private async findExistingUserByEmail(
    email: string
  ): Promise<OverseerrUser | null> {
    try {
      const overseerrAPI = this.getOverseerrAPI();

      // Get all users and find by email (Overseerr doesn't have direct email search)
      const usersResponse = await overseerrAPI.getUsers({ take: 1000 }); // Get a large batch
      const existingUser = usersResponse.results.find(
        (user) => user.email === email
      );

      return existingUser || null;
    } catch (error) {
      logger.warn(`Failed to search for existing user by email: ${email}`, {
        label: 'Service User Manager',
        email,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Map internal permissions to Overseerr permission values
   */
  private mapToOverseerrPermissions(internalPermissions: number): number {
    // Based on your examples:
    // Manual approval (REQUEST only): 32
    // Auto approval (REQUEST + AUTO_APPROVE + AUTO_APPROVE_MOVIE + AUTO_APPROVE_TV): 160

    const hasAutoApprove = (internalPermissions & 896) > 0; // Check for auto-approve permissions (128+256+512)

    return hasAutoApprove ? 160 : 32;
  }

  /** Overseerr replaces the whole permissions field on write, so merge onto the account's current value instead of pushing the bare mapped one. */
  private async pushOverseerrPermissions(
    overseerrAPI: OverseerrAPI,
    externalUserId: number,
    internalPermissions: number,
    freshlyCreatedPermissions?: number
  ): Promise<void> {
    const current = Number.isInteger(freshlyCreatedPermissions)
      ? (freshlyCreatedPermissions as number)
      : await this.fetchCurrentExternalPermissions(
          overseerrAPI,
          externalUserId
        );

    const desired = this.mapToOverseerrPermissions(internalPermissions);
    const merged = (current & ~APPROVAL_DECIDING_BITS) | desired;

    logger.debug('Pushing Overseerr permissions', {
      label: 'Service User Manager',
      externalUserId,
      current,
      desired,
      merged,
    });

    await overseerrAPI.updateUserPermissions(externalUserId, merged);
  }

  /** Fetches the external user's live permissions; throws (typed on 404) rather than ever letting a caller push undetermined permissions. */
  private async fetchCurrentExternalPermissions(
    overseerrAPI: OverseerrAPI,
    externalUserId: number
  ): Promise<number> {
    let permissions: number;
    try {
      permissions = (await overseerrAPI.getUser(externalUserId)).permissions;
    } catch (error) {
      if (error instanceof AxiosError && error.response?.status === 404) {
        throw new StaleExternalOverseerrUserError(
          `External Overseerr user ${externalUserId} not found`
        );
      }
      throw error;
    }

    if (!Number.isInteger(permissions)) {
      throw new Error(
        `External Overseerr user ${externalUserId} returned non-integer permissions`
      );
    }

    return permissions;
  }

  /**
   * Generate a secure password for service users
   */
  private generateSecurePassword(): string {
    return randomUUID() + randomUUID().replace(/-/g, '');
  }
}

// Export singleton instance
export const serviceUserManager = new ServiceUserManager();
