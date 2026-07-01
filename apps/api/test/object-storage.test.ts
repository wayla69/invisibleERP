import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { objectStoreConfigured, isObjectRef, putObject, objectUrl, deleteObject } from '../src/common/object-storage';

// Receipt-photo (and any large blob) object-storage offload. S3-compatible via authorized HTTP PUT/DELETE;
// when unconfigured everything falls back to keeping the inline data URL (no behaviour change).
const DATA_URL = 'data:image/png;base64,aGVsbG8='; // "hello"

describe('object-storage — disabled (no OBJECT_STORE_URL)', () => {
  beforeEach(() => { delete process.env.OBJECT_STORE_URL; delete process.env.OBJECT_STORE_TOKEN; delete process.env.OBJECT_STORE_PUBLIC_URL; });
  it('reports not configured and putObject returns null (caller keeps the blob inline)', async () => {
    expect(objectStoreConfigured()).toBe(false);
    expect(await putObject('receipts/1/2/x', DATA_URL)).toBeNull();
  });
  it('objectUrl passes inline data URLs and sentinels through unchanged', () => {
    expect(objectUrl(DATA_URL)).toBe(DATA_URL);
    expect(objectUrl('[erased]')).toBe('[erased]');
    expect(objectUrl(null)).toBeNull();
  });
});

describe('object-storage — configured', () => {
  let fetchMock: any;
  beforeEach(() => {
    process.env.OBJECT_STORE_URL = 'https://store.example.com/bucket';
    process.env.OBJECT_STORE_TOKEN = 'sekret';
    delete process.env.OBJECT_STORE_PUBLIC_URL;
    fetchMock = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.OBJECT_STORE_URL; delete process.env.OBJECT_STORE_TOKEN; });

  it('PUTs the decoded bytes with content-type + auth and returns an objstore: reference', async () => {
    const ref = await putObject('receipts/1/2/abc', DATA_URL);
    expect(ref).toBe('objstore:receipts/1/2/abc');
    expect(isObjectRef(ref)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://store.example.com/bucket/receipts/1/2/abc');
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('image/png');
    expect(init.headers.Authorization).toBe('Bearer sekret');
    expect(Buffer.isBuffer(init.body)).toBe(true);
    expect(init.body.toString()).toBe('hello'); // base64 aGVsbG8= decoded
  });

  it('resolves a reference to a retrievable URL (public base wins when set)', () => {
    expect(objectUrl('objstore:receipts/1/2/abc')).toBe('https://store.example.com/bucket/receipts/1/2/abc');
    process.env.OBJECT_STORE_PUBLIC_URL = 'https://cdn.example.com';
    expect(objectUrl('objstore:receipts/1/2/abc')).toBe('https://cdn.example.com/receipts/1/2/abc');
  });

  it('returns null (caller falls back to inline) on a non-2xx or a transport error', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    expect(await putObject('k', DATA_URL)).toBeNull();
    fetchMock.mockRejectedValueOnce(new Error('network'));
    expect(await putObject('k', DATA_URL)).toBeNull();
  });

  it('rejects a non-data-URL body without calling fetch', async () => {
    expect(await putObject('k', 'not-a-data-url')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deleteObject issues a best-effort DELETE for a ref and no-ops for non-refs', async () => {
    await deleteObject('objstore:receipts/1/2/abc');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].method).toBe('DELETE');
    fetchMock.mockClear();
    await deleteObject(DATA_URL); // inline → nothing to delete
    await deleteObject('[erased]');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
