import { existsSync } from "node:fs";
import { setupE2e, STATE_DIR } from "../../scripts/e2e-setup";

export default async function globalSetup() {
  // E2E_KEEP_DB=1 re-uses the database left by the previous full run, to iterate on a single later spec quickly.
  // A full run (the default, and what CI does) always starts from an empty database.
  if (process.env.E2E_KEEP_DB === "1" && existsSync(`${STATE_DIR}/state.json`)) return;
  await setupE2e();
}
