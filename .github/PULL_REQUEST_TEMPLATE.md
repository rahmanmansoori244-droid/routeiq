## Summary

<!-- 1-3 bullet points -->

## Phase reference

Which CLAUDE.md section / phase does this touch?

- [ ] Phase 0 — skeleton
- [ ] Phase 1 — master data
- [ ] Phase 2 — order upload
- [ ] Phase 3 — optimization engine
- [ ] Phase 4 — map / exports / dispatch
- [ ] Phase 5 — dashboard + polish
- [ ] Cross-cutting (security / ops / tests / docs)
- [ ] v2 / post-v1 work

## Tenant isolation

If you added a new tenant-scoped model or endpoint:

- [ ] Added to `TENANT_SCOPED_MODELS` in `lib/tenant.ts`
- [ ] Added a row to the cross-tenant matrix in `tests/integration/cross-tenant.spec.ts`
- [ ] Confirmed `tenantDb()` is used for the new query path

## Test plan

- [ ] `pnpm --filter @routeiq/web exec tsc --noEmit` clean
- [ ] `pnpm --filter @routeiq/web exec vitest run tests/lib tests/tenant-isolation.spec.ts` green
- [ ] `pnpm --filter @routeiq/web exec vitest run tests/integration` green (dev server + solver up)
- [ ] `apps/solver$ pytest tests` green
- [ ] Manually exercised the change in the browser
