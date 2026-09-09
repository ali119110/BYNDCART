import { startWorkerDaemon } from "../app/worker.server.js";

console.log("[Standalone Worker Process] Initializing worker process...");

const stopDaemon = startWorkerDaemon(2000);

process.on("SIGINT", () => {
  console.log("[Standalone Worker Process] Received SIGINT. Shutting down...");
  stopDaemon();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[Standalone Worker Process] Received SIGTERM. Shutting down...");
  stopDaemon();
  process.exit(0);
});
