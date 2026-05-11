-- RouteIQ: enable PostGIS before Prisma's schema migrations run.
-- v1 stores lat/lng as plain Float columns and does not depend on PostGIS at query time,
-- but v2 will use geography columns (region polygons, road-distance providers) and we
-- want the extension provisioned now so v2 migrations are a no-op operationally.
--
-- DO-block wraps CREATE EXTENSION so the migration is portable to dev DBs that
-- don't have PostGIS available (e.g. a vanilla local PostgreSQL install). On
-- Railway production we use the postgis/postgis image and the extension is
-- always present. The DBA receives a NOTICE either way.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS postgis;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'PostGIS extension not installed on this server; continuing without it (v1 does not depend on it at query time).';
END $$;
