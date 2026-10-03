// Standalone ingestion worker, for deployments that run it separately from the API
// (set INGEST_IN_PROCESS=false on the API in that case).
import { migrate } from '../db/migrate.js';
import { startScheduler } from './scheduler.js';

await migrate();
startScheduler();
