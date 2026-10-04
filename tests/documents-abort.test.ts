import type { Stats } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Trydoku } from '../src/index.ts';
import { mockFetch } from './helpers.ts';

vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), stat: vi.fn() }));

beforeEach(() => {
  vi.mocked(readFile).mockReset();
  vi.mocked(stat).mockReset();
  vi.mocked(stat).mockResolvedValue({ isFile: () => true, size: 32 } as Stats);
});

describe('generateFromFile file-read cancellation', () => {
  it('preserves the caller abort reason when the pending file read rejects with AbortError', async () => {
    const controller = new AbortController();
    const reason = new Error('Cancelled by caller');
    const fetchMock = mockFetch();
    let markReadPending: (() => void) | undefined;
    const readPending = new Promise<void>((resolve) => { markReadPending = resolve; });
    vi.mocked(readFile).mockImplementation((_file, options) => new Promise<never>((_resolve, reject) => {
      if (typeof options !== 'object' || options === null || !('signal' in options) || !(options.signal instanceof AbortSignal)) {
        throw new Error('Expected readFile to receive the caller signal.');
      }
      options.signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted', 'AbortError')), { once: true });
      markReadPending?.();
    }));
    const request = new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(
      '/templates/example.docx', { data: [{}] }, { signal: controller.signal },
    );
    const assertion = expect(request).rejects.toBe(reason);

    await readPending;
    controller.abort(reason);

    await assertion;
    expect(readFile).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('preserves the original file-system error when no caller abort occurred', async () => {
    const originalError = Object.assign(new Error('File disappeared before reading'), { code: 'ENOENT' });
    vi.mocked(readFile).mockRejectedValue(originalError);
    const fetchMock = mockFetch();

    await expect(new Trydoku({ apiKey: 'key', fetch: fetchMock }).documents.generateFromFile(
      '/templates/example.docx', { data: [{}] },
    )).rejects.toBe(originalError);

    expect(readFile).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
