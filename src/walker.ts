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
  // C/C++. Mapped to 'cpp' so the walker COLLECTS these files — they were
  // previously unmapped and silently dropped, which hid ~91% of a C++ codebase.
  // chunkFile() has a `case 'cpp'` that routes them through chunkCpp(), a
  // tree-sitter path giving real declaration boundaries and symbol names. The
  // grammar is lazy-loaded and degrades to chunkFallback() if unavailable.
  '.cpp': 'cpp',
  // `.h` is ambiguous (C vs C++ header). Treated as C++: the overwhelmingly
  // common case in modern codebases. tree-sitter-cpp parses plain C headers
  // without erroring, so the choice only affects the stored `language` field.
  '.h': 'cpp',
  '.hpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  // Header-only inline implementations, e.g. rippled's `*.ipp`.
  '.ipp': 'cpp',
  // X-macro tables. These are NOT valid C++ — they are a list of top-level
  // macro invocations (`TRANSACTION(...)`, `TYPED_SFIELD(...)`) consumed by
  // `#include` into a generator, so tree-sitter parses them into noise. Mapped
  // to their own language so chunkFile() routes them to chunkMacro(), which
  // splits on invocation boundaries and keeps one entry per chunk.
  //
  // Unmapped extensions are silently dropped by walkFiles(), and these files
  // are where a C++ project's authoritative tables live. In rippled that is
  // `include/xrpl/protocol/detail/*.macro`: every transaction's field list and
  // every serialized field's type/code live in these five files. Dropping them
  // makes the index unable to answer "which fields does transaction X accept?"
  // — precisely the question a protocol audit asks.
  '.macro': 'macro',
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

    // An entry may name a single file (e.g. a root README.md or AGENTS.md). Globbing
    // '**/*' with a file as cwd matches nothing, so such an entry used to be silently empty.
    const isFile = fs.statSync(dirPath).isFile();
    const matches = isFile
      ? [path.basename(dirPath)]
      : await glob('**/*', {
          cwd: dirPath,
          nodir: true,
          absolute: false,
          dot: false,
        });

    for (const match of matches) {
      const relativePath = isFile ? path.normalize(dir) : path.join(dir, match);

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

/**
 * Every path whose existing chunks must be deleted before an incremental upsert: removed
 * files AND changed files. Chunk ids are hash(path:startLine), so an upsert only replaces a
 * chunk whose start line did not move — without clearing a changed file first, every edit
 * that shifts a chunk boundary leaves the old chunk in the collection forever.
 */
export function pathsToClear(changes: {
  toIndex: FileEntry[];
  toDelete: string[];
}): string[] {
  return [...new Set([...changes.toDelete, ...changes.toIndex.map((f) => f.relativePath)])];
}
