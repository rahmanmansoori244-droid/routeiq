-- Dispatch timing per case: loading time at the depot before each load (per case of that load,
-- on top of the reload time) and unloading time at the customer (per case, on top of the
-- customer's service time). 0 keeps the old fixed times.
ALTER TABLE "TenantConfig" ADD COLUMN "loadingMinPerCase" DOUBLE PRECISION NOT NULL DEFAULT 0,
    ADD COLUMN "serviceMinPerCase" DOUBLE PRECISION NOT NULL DEFAULT 0;
