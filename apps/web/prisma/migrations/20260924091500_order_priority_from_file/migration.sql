-- A priority in the order file overrides the customer priority for that order only.
ALTER TABLE "Order" ADD COLUMN "priorityFromFile" BOOLEAN NOT NULL DEFAULT false;
