# TM-6 review
## Code review (Sonnet)
Verdict: approve

1. india_equity.py:85 (info): numbers.Real is correct. numpy int/float register with it. bool is still rejected first, and str/None fail the isinstance check. nan/inf/negatives are caught by isfinite and <0. Decimal is not a Real, so it is rejected, and test_tm6_numbers.py covers it.
2. india_equity.py:88-90 (nit): the message is "must be a finite number >= 0, got Decimal('0.00003')". It is clear enough, since the repr shows the type. It could say "real number (not Decimal/bool)", but that is optional.
3. main.ts:21-26,40 (info): the exited/bye guard is hoisted above the --once branch. The scheduler path still uses the same bye, so there is no other behaviour change. Two signals call exit(0) once, and tm6_once_exit.test.ts covers it.
4. tm6_once_exit.test.ts (nit): the test relies on a single `await Promise.resolve()` so that the handlers are registered before the signals fire. It works today but could be fragile if main gains an await before the registration. Use vi.waitFor on handlers.size.

Scope matches the brief. No blockers.
