import { createApp } from "./app.js";
import { SERVER_CONFIG, validateServerConfig } from "./env.js";
import { logger } from "../src/logger.js";

function main(): void {
  validateServerConfig();

  const app = createApp();
  app.listen(SERVER_CONFIG.port, () => {
    logger.info(`🛰️  Dashboard API listening on port ${SERVER_CONFIG.port}`);
  });
}

main();
