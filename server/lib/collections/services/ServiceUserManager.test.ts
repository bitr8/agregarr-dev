import { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Overseerr replaces permissions wholesale; sync must merge, not overwrite.

const { mockOverseerrAPI } = vi.hoisted(() => ({
  mockOverseerrAPI: {
    getUser: vi.fn(),
    updateUserPermissions: vi.fn(),
    disableUserNotifications: vi.fn(),
    createUser: vi.fn(),
    getUsers: vi.fn(),
  },
}));

vi.mock('@server/datasource', () => ({ getRepository: vi.fn() }));
vi.mock('@server/entity/User', () => ({ User: class {} }));
vi.mock('@server/api/overseerr', () => ({
  default: vi.fn().mockImplementation(function () {
    return mockOverseerrAPI;
  }),
}));
vi.mock('@server/logger', () => ({
  default: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const settings = {
  overseerr: { hostname: 'seerr.local', apiKey: 'key' },
  serviceUser: { userCreationMode: 'per-service' as const },
};
vi.mock('@server/lib/settings', () => ({ getSettings: () => settings }));

import { getRepository } from '@server/datasource';
import type { ServiceUserConfig } from './ServiceUserManager';
import { ServiceUserManager } from './ServiceUserManager';

const REQUEST = 32;
const AUTO_APPROVE = 128;
const AUTO_APPROVE_MOVIE = 256;
const AUTO_APPROVE_TV = 512;
const REQUEST_4K = 1024;
const AUTO_APPROVE_INTERNAL = 928; // REQUEST + AUTO_APPROVE + AUTO_APPROVE_MOVIE + AUTO_APPROVE_TV
const MANUAL_INTERNAL = 32;

function existingServiceUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    email: 'donotchangeme@overseerr.agregarr.invalid',
    displayName: 'OverseerrAgregarr',
    permissions: AUTO_APPROVE_INTERNAL,
    externalOverseerrId: 42,
    ...overrides,
  };
}

function serviceConfig(
  overrides: Partial<ServiceUserConfig> = {}
): ServiceUserConfig {
  return {
    username: 'OverseerrAgregarr',
    displayName: 'OverseerrAgregarr',
    email: 'donotchangeme@overseerr.agregarr.invalid',
    permissions: AUTO_APPROVE_INTERNAL,
    ...overrides,
  };
}

function stale404Error(): AxiosError {
  const error = new AxiosError('Not Found');
  Object.assign(error, { response: { status: 404 } });
  return error;
}

describe('ServiceUserManager - Overseerr permission push', () => {
  let userRepository: {
    findOne: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
  };
  let manager: ServiceUserManager;

  beforeEach(() => {
    vi.clearAllMocks();
    userRepository = { findOne: vi.fn(), save: vi.fn((u) => u) };
    vi.mocked(getRepository).mockReturnValue(
      userRepository as unknown as ReturnType<typeof getRepository>
    );
    manager = new ServiceUserManager();
  });

  it('auto-approve desired removes a stale type-specific bit while retaining unrelated bits', async () => {
    userRepository.findOne.mockResolvedValue(existingServiceUser());
    // Account has a stale AUTO_APPROVE_MOVIE grant plus a manually-granted REQUEST_4K.
    mockOverseerrAPI.getUser.mockResolvedValue({
      id: 42,
      permissions: REQUEST | AUTO_APPROVE_MOVIE | REQUEST_4K,
    });

    await manager.getOrCreateServiceUser(serviceConfig());

    expect(mockOverseerrAPI.updateUserPermissions).toHaveBeenCalledTimes(1);
    const [userId, pushedPermissions] =
      mockOverseerrAPI.updateUserPermissions.mock.calls[0];
    expect(userId).toBe(42);
    expect(pushedPermissions).toBe(REQUEST | AUTO_APPROVE | REQUEST_4K);
    expect(pushedPermissions & AUTO_APPROVE_MOVIE).toBe(0);
  });

  it('manual desired removes AUTO_APPROVE/MOVIE/TV while retaining unrelated bits', async () => {
    userRepository.findOne.mockResolvedValue(
      existingServiceUser({ permissions: MANUAL_INTERNAL })
    );
    mockOverseerrAPI.getUser.mockResolvedValue({
      id: 42,
      permissions:
        REQUEST |
        AUTO_APPROVE |
        AUTO_APPROVE_MOVIE |
        AUTO_APPROVE_TV |
        REQUEST_4K,
    });

    await manager.getOrCreateServiceUser(
      serviceConfig({ permissions: MANUAL_INTERNAL })
    );

    expect(mockOverseerrAPI.updateUserPermissions).toHaveBeenCalledTimes(1);
    const [, pushedPermissions] =
      mockOverseerrAPI.updateUserPermissions.mock.calls[0];
    expect(pushedPermissions).toBe(REQUEST | REQUEST_4K);
  });

  it.each([
    ['null', null],
    ['NaN', NaN],
    ['a non-integer string', 'not-a-number'],
  ])(
    '%s current permissions never reach the replacement POST',
    async (_label, badValue) => {
      userRepository.findOne.mockResolvedValue(existingServiceUser());
      mockOverseerrAPI.getUser.mockResolvedValue({
        id: 42,
        permissions: badValue,
      });
      mockOverseerrAPI.getUsers.mockResolvedValue({ results: [], total: 0 });
      mockOverseerrAPI.createUser.mockRejectedValue(
        new Error('recreate failed')
      );

      await expect(
        manager.getOrCreateServiceUser(serviceConfig())
      ).rejects.toThrow();

      expect(mockOverseerrAPI.updateUserPermissions).not.toHaveBeenCalled();
    }
  );

  it('a failed GET is never reported as success and no push follows it', async () => {
    userRepository.findOne.mockResolvedValue(existingServiceUser());
    mockOverseerrAPI.getUser.mockRejectedValue(new Error('network error'));
    mockOverseerrAPI.getUsers.mockResolvedValue({ results: [], total: 0 });
    mockOverseerrAPI.createUser.mockRejectedValue(new Error('recreate failed'));

    await expect(
      manager.getOrCreateServiceUser(serviceConfig())
    ).rejects.toThrow();

    expect(mockOverseerrAPI.updateUserPermissions).not.toHaveBeenCalled();
  });

  it('createServiceUser recreates a stale batch-list match and pushes against the new id', async () => {
    userRepository.findOne.mockResolvedValue(null); // no internal service user yet
    mockOverseerrAPI.getUsers.mockResolvedValue({
      results: [
        {
          id: 55,
          email: 'donotchangeme@overseerr.agregarr.invalid',
          permissions: REQUEST,
        },
      ],
      total: 1,
    });
    mockOverseerrAPI.getUser.mockRejectedValue(stale404Error()); // fresh GET on the matched id is stale
    mockOverseerrAPI.createUser.mockResolvedValue({
      id: 99,
      permissions: REQUEST | REQUEST_4K,
    });

    await manager.getOrCreateServiceUser(serviceConfig());

    expect(mockOverseerrAPI.updateUserPermissions).toHaveBeenCalledTimes(1);
    const [userId, pushedPermissions] =
      mockOverseerrAPI.updateUserPermissions.mock.calls[0];
    expect(userId).toBe(99);
    expect(pushedPermissions).toBe(REQUEST | AUTO_APPROVE | REQUEST_4K);
  });

  it('ensureExternalUser no-ID path never swallows a failed push into success', async () => {
    userRepository.findOne.mockResolvedValue(
      existingServiceUser({ externalOverseerrId: undefined })
    );
    mockOverseerrAPI.getUsers.mockResolvedValue({
      results: [
        {
          id: 55,
          email: 'donotchangeme@overseerr.agregarr.invalid',
          permissions: REQUEST,
        },
      ],
      total: 1,
    });
    mockOverseerrAPI.getUser.mockRejectedValue(stale404Error());

    await expect(
      manager.getOrCreateServiceUser(serviceConfig())
    ).rejects.toThrow();

    expect(mockOverseerrAPI.updateUserPermissions).not.toHaveBeenCalled();
  });

  it('a 404 on the stale external user routes into recreation and pushes against the new user', async () => {
    userRepository.findOne.mockResolvedValue(existingServiceUser());
    mockOverseerrAPI.getUser.mockRejectedValue(stale404Error());
    mockOverseerrAPI.getUsers.mockResolvedValue({ results: [], total: 0 });
    // New external account already carries REQUEST_4K from the instance default.
    mockOverseerrAPI.createUser.mockResolvedValue({
      id: 99,
      permissions: REQUEST | REQUEST_4K,
    });

    await manager.getOrCreateServiceUser(serviceConfig());

    expect(mockOverseerrAPI.updateUserPermissions).toHaveBeenCalledTimes(1);
    const [userId, pushedPermissions] =
      mockOverseerrAPI.updateUserPermissions.mock.calls[0];
    expect(userId).toBe(99);
    expect(pushedPermissions).toBe(REQUEST | AUTO_APPROVE | REQUEST_4K);
    expect(mockOverseerrAPI.updateUserPermissions).not.toHaveBeenCalledWith(
      42,
      expect.anything()
    );
  });
});
