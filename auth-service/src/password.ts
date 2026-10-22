import { hash, verify } from '@node-rs/argon2';

export type Argon2Params = { memoryCost: number; timeCost: number; parallelism: number };

/** Argon2id, 64 MiB, 3 passes (RFC 9106 second recommended option, single lane). */
export const PRODUCTION_ARGON2: Argon2Params = { memoryCost: 65_536, timeCost: 3, parallelism: 1 };

export const PASSWORD_MIN_LENGTH = 15;
export const PASSWORD_MAX_LENGTH = 1024;

export class PasswordHasher {
  constructor(private readonly params: Argon2Params = PRODUCTION_ARGON2) {}

  async hash(password: string): Promise<string> {
    // @node-rs/argon2 defaults to Argon2id; the check below makes that a guarantee.
    const encoded = await hash(password, { ...this.params, outputLen: 32 });
    if (!encoded.startsWith('$argon2id$')) {
      throw new Error('Password hashing did not produce an Argon2id hash.');
    }
    return encoded;
  }

  /** Cost comes from the encoded hash, so old hashes still verify after a parameter change. */
  async verify(encoded: string, password: string): Promise<boolean> {
    try {
      return await verify(encoded, password);
    } catch {
      return false;
    }
  }
}

/** Returns a reason the password is unacceptable, or null. Applied when setting a password, never at login. */
export function passwordProblem(password: string, username: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  if (password.trim() !== password) return 'Password must not start or end with whitespace.';
  if (new Set(password).size < 5) return 'Password is too repetitive.';
  if (password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username.';
  return null;
}
