// Household tools v1 need nothing beyond the transaction-scoped ctx.db; the
// deps object exists so M5.5's calendar client (and later external clients)
// land by widening this type instead of re-shaping the registry.

export type HouseholdToolDeps = Record<string, never>;
