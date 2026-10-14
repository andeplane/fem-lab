import { ServiceFailure } from './errors';

export interface VerifiedToken {
  uid: string; aud: string; iss: string; exp: number; auth_time: number;
  email?: string; email_verified?: boolean;
}
export interface IdentityAdmin { verifyIdToken(token: string, checkRevoked: boolean): Promise<VerifiedToken> }
export interface Identity { uid: string; email: string }

/** The real adapter is Firebase Admin: signature/key rotation, expiry, revocation and disabled-user checks. */
export function identityVerifier(admin: IdentityAdmin, projectId: string, now: () => Date) {
  return async (authorization: string | undefined): Promise<Identity> => {
    const match = /^Bearer ([^\s]{1,10000})$/.exec(authorization ?? '');
    if (!match) throw new ServiceFailure(401, 'login-required', 'Sign in to use hosted AI.', 'identity', 'account.signIn');
    let claims: VerifiedToken;
    try { claims = await admin.verifyIdToken(match[1]!, true); }
    catch { throw new ServiceFailure(401, 'invalid-identity', 'Your session is no longer valid. Sign in again.', 'identity', 'account.signIn'); }
    const seconds = Math.floor(now().getTime() / 1000);
    if (claims.aud !== projectId || claims.iss !== `https://securetoken.google.com/${projectId}` ||
      !claims.uid || claims.uid.length > 128 || claims.exp <= seconds || claims.auth_time > seconds) {
      throw new ServiceFailure(401, 'invalid-identity', 'Your session is no longer valid. Sign in again.', 'identity', 'account.signIn');
    }
    if (claims.email_verified !== true || !claims.email) {
      throw new ServiceFailure(403, 'email-verification-required', 'Verify your email before using hosted AI.', 'identity', 'account.signIn');
    }
    return { uid: claims.uid, email: claims.email };
  };
}
