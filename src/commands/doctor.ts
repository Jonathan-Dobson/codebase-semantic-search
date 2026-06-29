import net from 'net';
import { CONFIG } from '../config.js';

interface Check {
  name: string;
  status: 'ok' | 'fail' | 'warn';
  detail: string;
}

async function checkOllama(): Promise<Check> {
  try {
    const res = await fetch(`${CONFIG.ollamaHost}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      return {
        name: 'Ollama',
        status: 'fail',
        detail: `HTTP ${res.status} from ${CONFIG.ollamaHost}`,
      };
    }
    const data: any = await res.json();
    const models: string[] = (data.models ?? []).map((m: any) => m.name);
    const hasModel = models.some((m) => m.startsWith(CONFIG.embeddingModel));
    return {
      name: 'Ollama',
      status: hasModel ? 'ok' : 'warn',
      detail: hasModel
        ? `${CONFIG.ollamaHost} running, model "${CONFIG.embeddingModel}" available`
        : `${CONFIG.ollamaHost} running, but model "${CONFIG.embeddingModel}" not pulled. Run: ollama pull ${CONFIG.embeddingModel}`,
    };
  } catch (err: any) {
    return {
      name: 'Ollama',
      status: 'fail',
      detail: `Cannot reach ${CONFIG.ollamaHost} — is Ollama running? ${err.message}`,
    };
  }
}

async function checkMilvus(): Promise<Check> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({
        name: 'Milvus',
        status: 'fail',
        detail: `Connection to ${CONFIG.milvusHost}:${CONFIG.milvusPort} timed out`,
      });
    }, 3000);

    socket.connect(CONFIG.milvusPort, CONFIG.milvusHost, () => {
      clearTimeout(timer);
      socket.end();
      resolve({
        name: 'Milvus',
        status: 'ok',
        detail: `${CONFIG.milvusHost}:${CONFIG.milvusPort} reachable`,
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        name: 'Milvus',
        status: 'fail',
        detail: `Cannot reach ${CONFIG.milvusHost}:${CONFIG.milvusPort} — start it with: docker compose -f docker-compose.search.yml up -d`,
      });
    });
  });
}

function checkWorkspace(): Check {
  return {
    name: 'Workspace',
    status: 'ok',
    detail: `${CONFIG.workspaceRoot}`,
  };
}

export async function doctorCommand(): Promise<void> {
  console.log('=== Codebase Semantic Search — doctor ===\n');
  const checks = await Promise.all([checkOllama(), checkMilvus()]);
  checks.unshift(checkWorkspace());

  for (const c of checks) {
    const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : '✗';
    const color =
      c.status === 'ok' ? '\x1b[32m' : c.status === 'warn' ? '\x1b[33m' : '\x1b[31m';
    console.log(`  ${color}${icon}\x1b[0m  ${c.name.padEnd(12)}  ${c.detail}`);
  }

  const failed = checks.filter((c) => c.status === 'fail').length;
  if (failed > 0) {
    console.log(`\n${failed} check(s) failed. Fix and re-run.`);
    process.exit(1);
  }
  console.log('\nAll prerequisites OK.');
}
