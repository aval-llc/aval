import { customType } from "drizzle-orm/pg-core";

/**
 * Keep Aval's existing repository contract while storing structured JSONB.
 *
 * The D1 repositories exchange JSON as strings. node-postgres normally
 * deserializes jsonb to objects, which would make a database-only migration
 * change application behavior in dozens of call sites. This adapter parses on
 * writes and serializes on reads. Send validated JSON text to pg: JS arrays
 * otherwise become PostgreSQL array literals, and JSON strings lose quotes.
 */
export const jsonText = customType<{
  data: string;
  driverData: unknown;
}>({
  dataType() {
    return "jsonb";
  },
  toDriver(value) {
    try {
      return JSON.stringify(JSON.parse(value));
    } catch {
      throw new Error("Invalid JSON supplied to a PostgreSQL JSONB column");
    }
  },
  fromDriver(value) {
    return JSON.stringify(value);
  },
});
