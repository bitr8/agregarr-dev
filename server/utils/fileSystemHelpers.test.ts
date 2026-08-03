import path from 'path';
import { describe, expect, it } from 'vitest';
import { isContainedPath } from './fileSystemHelpers';

describe('isContainedPath', () => {
  const root = '/app/config/icons';

  it('allows a flat file inside root', () => {
    expect(isContainedPath(path.join(root, 'icon.svg'), root)).toBe(true);
  });

  it('allows a nested file inside root', () => {
    expect(isContainedPath(path.join(root, 'sub', 'icon.svg'), root)).toBe(
      true
    );
  });

  it('blocks dot-dot traversal', () => {
    expect(isContainedPath(path.join(root, '..', 'settings.json'), root)).toBe(
      false
    );
  });

  it('blocks nested dot-dot traversal', () => {
    expect(
      isContainedPath(path.join(root, 'sub', '..', '..', 'settings.json'), root)
    ).toBe(false);
  });

  it('blocks sibling prefix attack', () => {
    expect(isContainedPath('/app/config/icons-evil/x.svg', root)).toBe(false);
  });

  it('blocks absolute path outside root', () => {
    expect(isContainedPath('/etc/passwd', root)).toBe(false);
  });

  it('rejects the root itself (must be inside, not equal)', () => {
    expect(isContainedPath(root, root)).toBe(false);
  });
});
