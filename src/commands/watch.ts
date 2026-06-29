import { startWatcher } from '../watcher.js';

export async function watchCommand(): Promise<void> {
  await startWatcher();
  // Keep the process alive
  process.stdin.resume();
}
