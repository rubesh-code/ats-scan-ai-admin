import { describe, expect, it, vi } from 'vitest';

import { cachedSource, SourceError, supabaseSource, type Source } from '../src/source.js';
import { snapshot } from './fixtures.js';

const SUPABASE = { url: 'https://db.example.supabase.co', serviceRoleKey: 'service-key' };

function fakeFetch(rowsFor: (table: string, offset: number) => unknown[] | Response) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = new URL(String(input));
    const table = url.pathname.replace('/rest/v1/', '');
    const result = rowsFor(table, Number(url.searchParams.get('offset') ?? 0));
    return result instanceof Response ? result : Response.json(result);
  });
}

describe('supabaseSource', () => {
  it('requests only the listed columns, with the service key', async () => {
    const fetchImpl = fakeFetch(() => []);
    await supabaseSource(SUPABASE, fetchImpl as unknown as typeof fetch).snapshot();
    const urls = fetchImpl.mock.calls.map(([u]) => new URL(String(u)));
    const selects = Object.fromEntries(urls.map((u) => [u.pathname.replace('/rest/v1/', ''), u.searchParams.get('select')]));
    expect(Object.keys(selects).sort()).toEqual(
      ['credit_packages', 'credit_transactions', 'otp_codes', 'payments', 'scans', 'users'].sort(),
    );
    const all = Object.values(selects).join(',');
    for (const secret of ['otp_hash', 'signature', 'cashfree_response', 'session', 'extracted_text', 'file_path', 'result_data', 'job_description']) {
      expect(all).not.toContain(secret);
    }
    expect(urls.find((u) => u.pathname.endsWith('otp_codes'))!.searchParams.get('verified')).toBe('is.true');
    const init = fetchImpl.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toMatchObject({ apikey: 'service-key', Authorization: 'Bearer service-key' });
  });

  it('pages past the 1000-row cap', async () => {
    const fetchImpl = fakeFetch((table, offset) =>
      table === 'scans' ? Array.from({ length: offset === 0 ? 1000 : 3 }, (_, i) => ({ id: `${offset + i}` })) : [],
    );
    const data = await supabaseSource(SUPABASE, fetchImpl as unknown as typeof fetch).snapshot();
    expect(data.scans).toHaveLength(1003);
  });

  it('reports a failed read without the response body', async () => {
    const fetchImpl = fakeFetch(() => new Response('{"message":"secret detail"}', { status: 500 }));
    const error = await supabaseSource(SUPABASE, fetchImpl as unknown as typeof fetch).snapshot().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).not.toContain('secret');
  });
});

describe('cachedSource', () => {
  it('shares one load between concurrent requests and reuses it until it expires', async () => {
    let t = 0;
    const load = vi.fn(async () => snapshot());
    const source = cachedSource({ snapshot: load, ping: async () => {} } satisfies Source, 30_000, () => t);
    await Promise.all([source.snapshot(), source.snapshot(), source.snapshot()]);
    expect(load).toHaveBeenCalledTimes(1);
    t = 29_999;
    await source.snapshot();
    expect(load).toHaveBeenCalledTimes(1);
    t = 30_000;
    await source.snapshot();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    const load = vi.fn().mockRejectedValueOnce(new SourceError('down')).mockResolvedValue(snapshot());
    const source = cachedSource({ snapshot: load, ping: async () => {} }, 30_000);
    await expect(source.snapshot()).rejects.toThrow('down');
    await expect(source.snapshot()).resolves.toBeTruthy();
  });
});
