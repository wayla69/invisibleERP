import { describe, it, expect } from 'vitest';
import { withTimeout } from '../src/modules/pdf/pdf-renderer.service';

describe('withTimeout — bounds the in-process PDF render', () => {
  it('resolves a promise that settles before the deadline', async () => {
    await expect(withTimeout(Promise.resolve(42), 50)).resolves.toBe(42);
  });

  it('rejects when the operation exceeds the deadline (a hung render cannot pin the request)', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'PDF render')).rejects.toThrow(/timed out/);
  });

  it('propagates the underlying rejection unchanged', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 50)).rejects.toThrow('boom');
  });
});
