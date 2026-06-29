import { runIndexer } from '../indexer.js';

interface IndexOptions {
  full?: boolean;
  dryRun?: boolean;
}

export async function indexCommand(opts: IndexOptions): Promise<void> {
  await runIndexer({
    full: opts.full,
    dryRun: opts.dryRun,
  });
}
