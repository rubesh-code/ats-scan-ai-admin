import { describe, expectTypeOf, it } from 'vitest';

import type * as Api from '../src/types.js';
import type * as Dashboard from '../../src/api/types.js';

/**
 * src/types.ts is a copy of the dashboard's contract. `npm run typecheck`
 * fails here if either side changes without the other.
 */
describe('response types match the dashboard', () => {
  it('are identical', () => {
    expectTypeOf<Api.Overview>().toEqualTypeOf<Dashboard.Overview>();
    expectTypeOf<Api.Page<Api.UserSummary>>().toEqualTypeOf<Dashboard.Page<Dashboard.UserSummary>>();
    expectTypeOf<Api.UserDetail>().toEqualTypeOf<Dashboard.UserDetail>();
    expectTypeOf<Api.ScanRecord>().toEqualTypeOf<Dashboard.ScanRecord>();
    expectTypeOf<Api.ScanSummary>().toEqualTypeOf<Dashboard.ScanSummary>();
    expectTypeOf<Api.CreditTransaction>().toEqualTypeOf<Dashboard.CreditTransaction>();
    expectTypeOf<Api.CreditSummary>().toEqualTypeOf<Dashboard.CreditSummary>();
    expectTypeOf<Api.PaymentRecord>().toEqualTypeOf<Dashboard.PaymentRecord>();
    expectTypeOf<Api.PaymentSummary>().toEqualTypeOf<Dashboard.PaymentSummary>();
    expectTypeOf<Api.SystemHealth>().toEqualTypeOf<Dashboard.SystemHealth>();
  });
});
