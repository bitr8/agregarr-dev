import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, stateMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  stateMock: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: spawnMock }));
vi.mock('./youtubeCookies', () => ({
  getYoutubeCookiesState: stateMock,
  youtubeCookiesPath: () => '/cfg/youtube-cookies.txt',
}));

import { downloadWithYtDlp, searchYouTube } from './trailerDownload';

function fakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit('close', 0));
  return proc;
}

describe('downloadWithYtDlp cookies', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(fakeProcess);
  });

  it.each(['invalid', 'missing'])('omits --cookies when %s', async (state) => {
    stateMock.mockReturnValue(state);
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4');
    expect(spawnMock.mock.calls[0][1]).not.toContain('--cookies');
  });

  it('passes --cookies when valid', async () => {
    stateMock.mockReturnValue('valid');
    await downloadWithYtDlp('https://youtu.be/x', '/tmp/out.mp4');
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--cookies') + 1]).toBe(
      '/cfg/youtube-cookies.txt'
    );
  });
});

describe('searchYouTube', () => {
  beforeEach(() => spawnMock.mockReset());

  it('parses id/title lines and passes cookies to the search', async () => {
    stateMock.mockReturnValue('valid');
    spawnMock.mockImplementation(() => {
      const proc = fakeProcess();
      process.nextTick(() =>
        proc.stdout.emit(
          'data',
          Buffer.from('abc123\tDune\tTrailer\nxyz\tTwo\n')
        )
      );
      return proc;
    });
    const results = await searchYouTube('Dune 2021 official trailer', 10);
    expect(results).toEqual([
      { videoId: 'abc123', title: 'Dune\tTrailer' },
      { videoId: 'xyz', title: 'Two' },
    ]);
    const args = spawnMock.mock.calls[0][1] as string[];
    expect(args).toContain('--cookies');
    expect(args[args.length - 1]).toBe('ytsearch10:Dune 2021 official trailer');
  });

  it('rejects on a non-zero exit so the caller falls back', async () => {
    stateMock.mockReturnValue('missing');
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      setImmediate(() => proc.emit('close', 1));
      return proc;
    });
    await expect(searchYouTube('x', 10)).rejects.toThrow('code 1');
  });
});
