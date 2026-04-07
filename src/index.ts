import { definePluginEntry } from "openclaw/plugin-sdk/core";
import { initDatabase } from "./db/schema.js";
import {
  registerHealthcheckRoute,
  registerIngestRoute,
  registerQueryRoutes,
} from "./routes/index.js";
import { registerHealthTools } from "./tools/index.js";
import { getStoragePath, getConfig } from "./utils/config.js";

export default definePluginEntry({
  id: "health-sync",
  name: "Health Sync",

  register(api) {
    // 1. Resolve storage path and init database
    const storagePath = getStoragePath(api);
    const db = initDatabase(storagePath);

    // 2. Resolve full config (including API key auto-generation)
    const config = getConfig(api, db);

    // 3. Register HTTP routes
    registerHealthcheckRoute(api, db, config.apiKey);
    registerIngestRoute(api, db, config.apiKey, config.timezone);
    registerQueryRoutes(api, db, config.summaryCacheTtlMinutes, config.timezone);

    // 4. Register agent tools
    registerHealthTools(api, db, config);

    // 5. Clean shutdown
    process.on("exit", () => db.close());

    // 6. Log setup info
    console.log(`[health-sync] SQLite database ready at ${storagePath}`);
    console.log(`[health-sync] API Key: ${config.apiKey}`);
    console.log("[health-sync] Ingest endpoint: POST /api/v1/health/ingest");
    console.log("[health-sync] Ready! (hot reload test)");
  },
});
