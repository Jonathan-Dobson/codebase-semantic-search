import { startServer } from '../search-server.js';

export async function serveCommand(): Promise<void> {
  await startServer();
}
