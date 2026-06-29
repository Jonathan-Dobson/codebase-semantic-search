import { startServer } from '../search-server.js';
import { startWatcher } from '../watcher.js';

export async function serveAndWatchCommand(): Promise<void> {
  await startServer();
  await startWatcher();
  process.stdin.resume();
}
