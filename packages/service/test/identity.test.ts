import { describe, expect, it, vi } from 'vitest';
import { identityVerifier, type VerifiedToken } from '../src/identity';
import { accountReader, postgresAccounts } from '../src/accounts';

const now = () => new Date('2026-10-14T12:00:00Z');
const valid: VerifiedToken = { uid: 'user-1', email: 'person@example.com', email_verified: true, aud: 'femlab-test', iss: 'https://securetoken.google.com/femlab-test', exp: now().getTime() / 1000 + 3600, auth_time: now().getTime() / 1000 - 60 };
describe('verified account identity', () => {
  it('asks Firebase to check signature, project and revocation on every use, including refreshed tokens', async () => {
    const verifyIdToken = vi.fn(async () => valid);
    const verify = identityVerifier({ verifyIdToken }, 'femlab-test', now);
    expect(await verify('Bearer token-1')).toEqual({ uid: valid.uid, email: valid.email });
    await verify('Bearer refreshed-token');
    expect(verifyIdToken.mock.calls).toEqual([['token-1', true], ['refreshed-token', true]]);
  });
  it('refuses malformed credentials before calling Firebase', async () => {
    const verifyIdToken = vi.fn(async () => valid);
    for (const header of [undefined, 'Basic secret', 'Bearer', 'Bearer a b', `Bearer ${'a'.repeat(10001)}`]) {
      await expect(identityVerifier({ verifyIdToken }, 'femlab-test', now)(header)).rejects.toMatchObject({ status: 401, code: 'login-required' });
    }
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
  it.each(['auth/id-token-expired', 'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found', 'auth/argument-error'])('redacts Firebase failures: %s', async code => {
    await expect(identityVerifier({ verifyIdToken: async () => { throw new Error(`${code}: private token`); } }, 'femlab-test', now)('Bearer private-token'))
      .rejects.toMatchObject({ status: 401, code: 'invalid-identity', message: 'Your session is no longer valid. Sign in again.' });
  });
  it.each([{ aud: 'other' }, { iss: 'https://securetoken.google.com/other' }, { exp: valid.exp - 3600 }, { auth_time: valid.exp }, { uid: '' }, { uid: 'x'.repeat(129) }])('rejects mismatched claims %j', async change => {
    await expect(identityVerifier({ verifyIdToken: async () => ({ ...valid, ...change }) }, 'femlab-test', now)('Bearer token'))
      .rejects.toMatchObject({ status: 401, code: 'invalid-identity' });
  });
  it.each([{ email_verified: false }, { email: undefined }])('requires trusted verification %j', async change => {
    await expect(identityVerifier({ verifyIdToken: async () => ({ ...valid, ...change }) }, 'femlab-test', now)('Bearer token'))
      .rejects.toMatchObject({ status: 403, code: 'email-verification-required' });
  });
  it('provisions only the verified UID and never accepts an account selector', async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rowCount: 1, rows: [{ id: '11111111-1111-4111-8111-111111111111', email: valid.email, created_at: now(), status: 'active' }] }));
    const read = accountReader(async () => ({ uid: valid.uid, email: valid.email! }), postgresAccounts({ query }, now, () => '11111111-1111-4111-8111-111111111111'));
    expect((await read('Bearer token')).status).toBe('active');
    expect(query.mock.calls[0]?.[1]).toEqual(['11111111-1111-4111-8111-111111111111', valid.uid, valid.email, now()]);
    expect(query.mock.calls[0]?.[0]).toContain('ON CONFLICT (firebase_uid)');
  });
  it('refuses an account awaiting deletion', async () => {
    const accounts = postgresAccounts({ query: async () => ({ rows: [], rowCount: 0 }) }, now, () => '11111111-1111-4111-8111-111111111111');
    await expect(accounts.provision({ uid: 'deleting', email: 'old@example.com' })).rejects.toMatchObject({ status: 403, code: 'account-inactive' });
  });
});
