import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('dns/promises', () => ({
  default: {
    resolve4: vi.fn(),
    resolve6: vi.fn(),
  },
}));

import dns from 'dns/promises';
import { validateExternalUrl } from './urlValidator';

const mockResolve4 = vi.mocked(dns.resolve4);
const mockResolve6 = vi.mocked(dns.resolve6);

describe('validateExternalUrl', () => {
  beforeEach(() => {
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockResolve6.mockRejectedValue(new Error('no AAAA'));
  });

  it('allows a public URL', async () => {
    mockResolve4.mockResolvedValue(['93.184.216.34']);
    const result = await validateExternalUrl('https://example.com/icon.png');
    expect(result.hostname).toBe('example.com');
  });

  it('rejects loopback', async () => {
    mockResolve4.mockResolvedValue(['127.0.0.1']);
    await expect(validateExternalUrl('http://localhost/x')).rejects.toThrow(
      'private or reserved'
    );
  });

  it('rejects private 10.x', async () => {
    mockResolve4.mockResolvedValue(['10.0.0.1']);
    await expect(validateExternalUrl('http://internal.corp/x')).rejects.toThrow(
      'private or reserved'
    );
  });

  it('rejects private 192.168.x', async () => {
    mockResolve4.mockResolvedValue(['192.168.1.1']);
    await expect(validateExternalUrl('http://router.local/x')).rejects.toThrow(
      'private or reserved'
    );
  });

  it('rejects link-local', async () => {
    mockResolve4.mockResolvedValue(['169.254.1.1']);
    await expect(
      validateExternalUrl('http://link-local.test/x')
    ).rejects.toThrow('private or reserved');
  });

  it('rejects non-http protocol', async () => {
    await expect(validateExternalUrl('ftp://example.com/x')).rejects.toThrow(
      'HTTP and HTTPS'
    );
  });

  it('rejects URLs with credentials', async () => {
    await expect(
      validateExternalUrl('http://user:pass@example.com/x')
    ).rejects.toThrow('credentials');
  });

  it('rejects unresolvable hostname', async () => {
    mockResolve4.mockRejectedValue(new Error('ENOTFOUND'));
    await expect(
      validateExternalUrl('http://nonexistent.invalid/x')
    ).rejects.toThrow('Cannot resolve');
  });

  it('rejects IPv6 loopback', async () => {
    mockResolve4.mockRejectedValue(new Error('no A'));
    mockResolve6.mockResolvedValue(['::1']);
    await expect(
      validateExternalUrl('http://ipv6-loopback.test/x')
    ).rejects.toThrow('private or reserved');
  });

  it('rejects IPv4-mapped IPv6 private addresses (dotted)', async () => {
    mockResolve4.mockRejectedValue(new Error('no A'));
    mockResolve6.mockResolvedValue(['::ffff:10.0.0.1']);
    await expect(
      validateExternalUrl('http://mapped-private.test/x')
    ).rejects.toThrow('private or reserved');
  });

  it('rejects IPv4-mapped IPv6 private addresses (hex)', async () => {
    mockResolve4.mockRejectedValue(new Error('no A'));
    mockResolve6.mockResolvedValue(['::ffff:a00:1']);
    await expect(
      validateExternalUrl('http://mapped-hex.test/x')
    ).rejects.toThrow('private or reserved');
  });

  it('rejects cloud metadata endpoint', async () => {
    mockResolve4.mockResolvedValue(['169.254.169.254']);
    await expect(validateExternalUrl('http://metadata.test/x')).rejects.toThrow(
      'private or reserved'
    );
  });

  it('rejects reserved 240.x range', async () => {
    mockResolve4.mockResolvedValue(['240.0.0.1']);
    await expect(validateExternalUrl('http://reserved.test/x')).rejects.toThrow(
      'private or reserved'
    );
  });
});
