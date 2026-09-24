-- Road distances (OSRM) become the default distance provider for tenants the shared routing
-- server covers (it holds Oman + UAE roads only).
--
-- Before this release the solver silently upgraded HAVERSINE to OSRM whenever OSRM_URL was set
-- (it defaulted to the public demo server; days too big for that server fell back to
-- straight-line). The dispatch planner honours the configured provider, so Omani / UAE tenants
-- on HAVERSINE move to OSRM here to keep planning on road distances. Tenants in other countries
-- keep HAVERSINE (the app also plans them on straight-line estimates unless they configure
-- their own OSRM URL). Anyone can switch back in Settings.
--
-- Separate migration: an enum value added by ALTER TYPE (20260924090000) cannot be used in the
-- same transaction.
ALTER TABLE "TenantConfig" ALTER COLUMN "distanceProvider" SET DEFAULT 'OSRM';

UPDATE "TenantConfig" AS tc
   SET "distanceProvider" = 'OSRM'
  FROM "Tenant" AS t
 WHERE t.id = tc."tenantId"
   AND tc."distanceProvider" = 'HAVERSINE'
   AND (
        t.country !~ '[^[:space:]]'  -- blank / whitespace only
     OR t.country ~* '(^|[^a-z])(oman|om|omn|uae|u\.a\.e|ae|are|muscat|dubai|abu dhabi|sharjah)([^a-z]|$)'
     -- "Emirates" in European languages (Emirate, Emiratos, Emirati; \u00e9 / \u00c9 = e-acute, as in Emirats).
     OR t.country ~* '(e|\u00e9|\u00c9)mira[td]'
     -- Arabic spellings, as Unicode escapes to keep this file ASCII: Oman (with and without
     -- damma), UAE (with and without hamza). Same rules as isOmanUae() in lib/dispatch/customer-attrs.ts.
     OR strpos(t.country, U&'\0639\0645\0627\0646') > 0
     OR strpos(t.country, U&'\0639\064F\0645\0627\0646') > 0
     OR strpos(t.country, U&'\0627\0644\0625\0645\0627\0631\0627\062A') > 0
     OR strpos(t.country, U&'\0627\0644\0627\0645\0627\0631\0627\062A') > 0
   );
