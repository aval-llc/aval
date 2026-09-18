import { defineConfig } from "drizzle-kit";

export default defineConfig({
  out: "./db/postgres/migrations",
  schema: "./db/postgres/schema.ts",
  dialect: "postgresql",
});
