import fs from 'fs';
import path from 'path';
import { glob } from 'glob';
import ignore from 'ignore';
import { CONFIG } from './config.js';

export interface FileEntry {
  absolutePath: string;
  relativePath: string;
  language: string;
  module: string;
  lastModified: string;
}

const LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.md': 'markdown',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.sh': 'shell',
  '.sql': 'sql',
  '.tf': 'terraform',
  '.py': 'python',
};

function detectModule(relativePath: string): string {
  // First path segment under the project root is the module name.
  const parts = relativePath.split(path.sep);
  if (parts.length > 1) return parts[0];

  // Server-side modules often live under server/src/modules/{module}/...
  const serverModuleMatch = relativePath.match(
    /^server\/src\/modules\/([^/]+)/,
  );
  if (serverModuleMatch) return serverModuleMatch[1];

  if (relativePath.startsWith('docs/')) return 'docs';
  if (relativePath.startsWith('wiki/')) return 'wiki';

  return 'root';
}

function detectLanguage(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_MAP[ext] || 'text';
}

export async function walkFiles(): Promise<FileEntry[]> {
  const ig = ignore();

  // Respect .gitignore at the project root if present
  const gitignorePath = path.join(CONFIG.workspaceRoot, '.gitignore');
  if (fs.existsSync(gitignorePath)) {
    ig.add(fs.readFileSync(gitignorePath, 'utf-8'));
  }

  // Hard-coded exclusions
  ig.add(CONFIG.excludePatterns);

  const files: FileEntry[] = [];

  for (const dir of CONFIG.indexDirs) {
    const dirPath = path.join(CONFIG.workspaceRoot, dir);
    if (!fs.existsSync(dirPath)) {
      continue; // silently skip — many projects won't have all of these
    }

    const matches = await glob('**/*', {
      cwd: dirPath,
      nodir: true,
      absolute: false,
      dot: false,
    });

    for (const match of matches) {
      const relativePath = path.join(dir, match);

      if (ig.ignores(relativePath)) continue;

      const absolutePath = path.join(CONFIG.workspaceRoot, relativePath);

      // Skip files with unknown extensions unless likely text
      const lang = detectLanguage(absolutePath);
      if (
        lang === 'text' &&
        !match.endsWith('.txt') &&
        !match.endsWith('.md')
      ) {
        const ext = path.extname(match);
        if (!ext || LANGUAGE_MAP[ext] === undefined) {
          if (
            ![
              '.env',
              '.gitignore',
              '.dockerignore',
              '.editorconfig',
              '.prettierrc',
            ].some((e) => match.endsWith(e))
          ) {
            continue;
          }
        }
      }

      const stat = fs.statSync(absolutePath);

      files.push({
        absolutePath,
        relativePath,
        language: detectLanguage(absolutePath),
        module: detectModule(relativePath),
        lastModified: stat.mtime.toISOString(),
      });
    }
  }

  return files;
}

export interface IndexState {
  lastIndexedAt: string;
  fileHashes: Record<string, string>; // relativePath -> mtime ISO
}

export function loadIndexState(): IndexState | null {
  if (!fs.existsSync(CONFIG.stateFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG.stateFile, 'utf-8'));
  } catch {
    return null;
  }
}

export function saveIndexState(state: IndexState): void {
  fs.writeFileSync(CONFIG.stateFile, JSON.stringify(state, null, 2));
}

export function getChangedFiles(
  files: FileEntry[],
  state: IndexState | null,
): {
  toIndex: FileEntry[];
  toDelete: string[]; // relativePaths no longer present
} {
  if (!state) return { toIndex: files, toDelete: [] };

  const toIndex: FileEntry[] = [];
  const currentPaths = new Set(files.map((f) => f.relativePath));

  for (const file of files) {
    const prevMtime = state.fileHashes[file.relativePath];
    if (!prevMtime || prevMtime !== file.lastModified) {
      toIndex.push(file);
    }
  }

  const toDelete = Object.keys(state.fileHashes).filter(
    (p) => !currentPaths.has(p),
  );

  return { toIndex, toDelete };
}
