import { spawnSync } from 'child_process';
import fs from 'fs';

export async function downCommand(): Promise<void> {
  console.log('=== Codebase Semantic Search — down ===\n');

  const composeFile = 'docker-compose.search.yml';
  if (!fs.existsSync(composeFile)) {
    console.log(`[down] No ${composeFile} found in ${process.cwd()}. Nothing to stop.`);
    return;
  }

  console.log('[down] Stopping Milvus (docker compose down)...');
  const res = spawnSync(
    'docker',
    ['compose', '-f', composeFile, 'down'],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    throw new Error(`docker compose down exited with code ${res.status}`);
  }

  console.log('\n[down] Done. Volumes are preserved (your index is safe).');
  console.log('       Run `codesearch up` to bring everything back.');
  console.log(
    '       Run `docker compose -f docker-compose.search.yml down -v` to also remove volumes.',
  );
}
