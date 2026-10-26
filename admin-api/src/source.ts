/**
 * Read-only access to the customer database through Supabase's REST API.
 *
 * Only the columns below are ever requested: no OTP hashes, payment
 * signatures, provider responses, resume text, file paths or scan results.
 * Every report is computed from one snapshot of these rows; at the current
 * size (tens to thousands of rows) that is simpler and faster than one query
 * per figure. Revisit if a table grows past ~100k rows.
 */

export type UserRow = {
  id: string;
  name: string | null;
  email: string;
  credits: number | null;
  total_scans: number | null;
  avg_score: number | string | null;
  created_at: string;
};
export type ScanRow = {
  id: string;
  user_id: string;
  filename: string | null;
  score: number | string | null;
  status: string | null;
  type: string | null;
  job_role: string | null;
  credit_used: number | null;
  created_at: string;
};
export type TransactionRow = {
  id: string;
  user_id: string;
  payment_id: string | null;
  scan_id: string | null;
  type: string;
  credits: number;
  description: string | null;
  created_at: string;
};
export type PaymentRow = {
  id: string;
  user_id: string;
  package_id: string | null;
  payment_gateway: string | null;
  razorpay_order_id: string | null;
  razorpay_payment_id: string | null;
  cashfree_order_id: string | null;
  amount_inr: number;
  credits: number;
  status: string;
  created_at: string;
  verified_at: string | null;
};
export type PackageRow = { id: string; name: string };
/** A verified OTP is a sign-in; only its email and time are read. */
export type SignInRow = { email: string; created_at: string };

export type Snapshot = {
  users: UserRow[];
  scans: ScanRow[];
  transactions: TransactionRow[];
  payments: PaymentRow[];
  packages: PackageRow[];
  signIns: SignInRow[];
};

const TABLES = {
  users: { table: 'users', select: 'id,name,email,credits,total_scans,avg_score,created_at' },
  scans: {
    table: 'scans',
    select: 'id,user_id,filename,score,status,type,job_role,credit_used,created_at',
  },
  transactions: {
    table: 'credit_transactions',
    select: 'id,user_id,payment_id,scan_id,type,credits,description,created_at',
  },
  payments: {
    table: 'payments',
    select:
      'id,user_id,package_id,payment_gateway,razorpay_order_id,razorpay_payment_id,cashfree_order_id,amount_inr,credits,status,created_at,verified_at',
  },
  packages: { table: 'credit_packages', select: 'id,name' },
  signIns: { table: 'otp_codes', select: 'email,created_at', filter: 'verified=is.true' },
} as const;

/** Supabase's default row cap per request. */
const PAGE = 1000;
const TIMEOUT_MS = 10_000;

export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}

export type Source = {
  snapshot(): Promise<Snapshot>;
  /** One tiny query, for the health check. */
  ping(): Promise<void>;
};

export function supabaseSource(
  supabase: { url: string; serviceRoleKey: string },
  fetchImpl: typeof fetch = fetch,
): Source {
  const headers = {
    apikey: supabase.serviceRoleKey,
    Authorization: `Bearer ${supabase.serviceRoleKey}`,
    Accept: 'application/json',
  };

  async function get<T>(table: string, params: string): Promise<T[]> {
    let response: Response;
    try {
      response = await fetchImpl(`${supabase.url}/rest/v1/${table}?${params}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new SourceError(`${table}: no response`);
    }
    // The body may echo the query; only the status is logged.
    if (!response.ok) throw new SourceError(`${table}: HTTP ${response.status}`);
    return (await response.json()) as T[];
  }

  async function all<T>(spec: { table: string; select: string; filter?: string }): Promise<T[]> {
    const rows: T[] = [];
    for (let offset = 0; ; offset += PAGE) {
      const params = [`select=${spec.select}`, spec.filter, 'order=id', `limit=${PAGE}`, `offset=${offset}`]
        .filter(Boolean)
        .join('&');
      const page = await get<T>(spec.table, params);
      rows.push(...page);
      if (page.length < PAGE) return rows;
    }
  }

  return {
    async snapshot() {
      const [users, scans, transactions, payments, packages, signIns] = await Promise.all([
        all<UserRow>(TABLES.users),
        all<ScanRow>(TABLES.scans),
        all<TransactionRow>(TABLES.transactions),
        all<PaymentRow>(TABLES.payments),
        all<PackageRow>(TABLES.packages),
        all<SignInRow>(TABLES.signIns),
      ]);
      return { users, scans, transactions, payments, packages, signIns };
    },
    async ping() {
      await get('users', 'select=id&limit=1');
    },
  };
}

/**
 * Reuses a snapshot for `ttlMs`, and shares one in-flight load between
 * concurrent requests, so a dashboard page firing several calls at once
 * reads the database once.
 */
export function cachedSource(source: Source, ttlMs: number, now: () => number = Date.now): Source {
  let cached: { at: number; value: Snapshot } | null = null;
  let loading: Promise<Snapshot> | null = null;
  return {
    snapshot() {
      if (cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      loading ??= source
        .snapshot()
        .then((value) => {
          cached = { at: now(), value };
          return value;
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    },
    ping: () => source.ping(),
  };
}
