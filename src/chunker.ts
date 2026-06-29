import fs from 'fs';
import { Project, SyntaxKind, Node } from 'ts-morph';
import { CONFIG } from './config.js';
import type { FileEntry } from './walker.js';

export interface Chunk {
  id: string; // hash of file_path + start_line
  content: string;
  filePath: string;
  language: string;
  module: string;
  chunkType: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  lastModified: string;
}

function hashId(filePath: string, startLine: number): string {
  // Simple hash for chunk ID
  const str = `${filePath}:${startLine}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36).padStart(8, '0');
}

// Approximate token count (rough: 1 token ≈ 4 chars for code)
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function chunkByLines(content: string, maxTokens: number, overlap: number): { text: string; startLine: number; endLine: number }[] {
  const lines = content.split('\n');
  const chunks: { text: string; startLine: number; endLine: number }[] = [];

  let start = 0;
  while (start < lines.length) {
    let end = start;
    let text = '';

    while (end < lines.length) {
      const nextLine = lines[end] + '\n';
      if (estimateTokens(text + nextLine) > maxTokens && text.length > 0) break;
      text += nextLine;
      end++;
    }

    if (text.trim()) {
      chunks.push({
        text: text.trimEnd(),
        startLine: start + 1,
        endLine: end,
      });
    }

    start = Math.max(start + 1, end - overlap);
    if (end >= lines.length) break;
  }

  return chunks;
}

function chunkTypeScript(file: FileEntry): Chunk[] {
  const content = fs.readFileSync(file.absolutePath, 'utf-8');
  const chunks: Chunk[] = [];

  try {
    const project = new Project({ useInMemoryFileSystem: true });
    const sourceFile = project.createSourceFile('temp.ts', content);

    const topLevelNodes: { name: string; type: string; start: number; end: number; text: string }[] = [];

    // Extract functions
    sourceFile.getFunctions().forEach(fn => {
      topLevelNodes.push({
        name: fn.getName() || 'anonymous',
        type: 'function',
        start: fn.getStartLineNumber(),
        end: fn.getEndLineNumber(),
        text: fn.getFullText(),
      });
    });

    // Extract classes
    sourceFile.getClasses().forEach(cls => {
      topLevelNodes.push({
        name: cls.getName() || 'anonymous',
        type: 'class',
        start: cls.getStartLineNumber(),
        end: cls.getEndLineNumber(),
        text: cls.getFullText(),
      });
    });

    // Extract interfaces
    sourceFile.getInterfaces().forEach(iface => {
      topLevelNodes.push({
        name: iface.getName(),
        type: 'interface',
        start: iface.getStartLineNumber(),
        end: iface.getEndLineNumber(),
        text: iface.getFullText(),
      });
    });

    // Extract type aliases
    sourceFile.getTypeAliases().forEach(ta => {
      topLevelNodes.push({
        name: ta.getName(),
        type: 'type',
        start: ta.getStartLineNumber(),
        end: ta.getEndLineNumber(),
        text: ta.getFullText(),
      });
    });

    // Extract exported variable statements (const handlers, configs, etc.)
    sourceFile.getVariableStatements().forEach(vs => {
      if (vs.isExported() || estimateTokens(vs.getFullText()) > 100) {
        const decl = vs.getDeclarations()[0];
        topLevelNodes.push({
          name: decl?.getName() || 'variable',
          type: 'variable',
          start: vs.getStartLineNumber(),
          end: vs.getEndLineNumber(),
          text: vs.getFullText(),
        });
      }
    });

    // Sort by start line
    topLevelNodes.sort((a, b) => a.start - b.start);

    if (topLevelNodes.length === 0) {
      // No parseable top-level nodes, fall back to line chunking
      return chunkFallback(file, content);
    }

    // Add file header (imports, comments before first node) as a chunk
    if (topLevelNodes.length > 0 && topLevelNodes[0].start > 1) {
      const headerLines = content.split('\n').slice(0, topLevelNodes[0].start - 1);
      const headerText = headerLines.join('\n').trim();
      if (headerText && estimateTokens(headerText) > 50) {
        chunks.push({
          id: hashId(file.relativePath, 1),
          content: headerText,
          filePath: file.relativePath,
          language: file.language,
          module: file.module,
          chunkType: 'imports',
          symbolName: 'file-header',
          startLine: 1,
          endLine: topLevelNodes[0].start - 1,
          lastModified: file.lastModified,
        });
      }
    }

    // Process each top-level node
    for (const node of topLevelNodes) {
      const nodeText = node.text.trim();
      if (!nodeText) continue;

      if (estimateTokens(nodeText) <= CONFIG.maxChunkTokens) {
        chunks.push({
          id: hashId(file.relativePath, node.start),
          content: nodeText,
          filePath: file.relativePath,
          language: file.language,
          module: file.module,
          chunkType: node.type,
          symbolName: node.name,
          startLine: node.start,
          endLine: node.end,
          lastModified: file.lastModified,
        });
      } else {
        // Large node — split further
        const subChunks = chunkByLines(nodeText, CONFIG.maxChunkTokens, CONFIG.chunkOverlapLines);
        for (const sub of subChunks) {
          chunks.push({
            id: hashId(file.relativePath, node.start + sub.startLine - 1),
            content: sub.text,
            filePath: file.relativePath,
            language: file.language,
            module: file.module,
            chunkType: node.type,
            symbolName: node.name,
            startLine: node.start + sub.startLine - 1,
            endLine: node.start + sub.endLine - 1,
            lastModified: file.lastModified,
          });
        }
      }
    }

    return chunks;
  } catch {
    // If AST parsing fails, fall back to line-based chunking
    return chunkFallback(file, content);
  }
}

function chunkMarkdown(file: FileEntry): Chunk[] {
  const content = fs.readFileSync(file.absolutePath, 'utf-8');
  const lines = content.split('\n');
  const chunks: Chunk[] = [];

  let currentSection: { title: string; startLine: number; lines: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);

    if (headingMatch) {
      // Flush previous section
      if (currentSection && currentSection.lines.length > 0) {
        const text = currentSection.lines.join('\n').trim();
        if (text && estimateTokens(text) > 30) {
          const subChunks = chunkByLines(text, CONFIG.maxChunkTokens, CONFIG.chunkOverlapLines);
          for (const sub of subChunks) {
            chunks.push({
              id: hashId(file.relativePath, currentSection.startLine + sub.startLine - 1),
              content: sub.text,
              filePath: file.relativePath,
              language: file.language,
              module: file.module,
              chunkType: 'section',
              symbolName: currentSection.title,
              startLine: currentSection.startLine + sub.startLine - 1,
              endLine: currentSection.startLine + sub.endLine - 1,
              lastModified: file.lastModified,
            });
          }
        }
      }
      currentSection = { title: headingMatch[2], startLine: i + 1, lines: [line] };
    } else if (currentSection) {
      currentSection.lines.push(line);
    } else {
      // Content before first heading
      if (!currentSection) {
        currentSection = { title: 'intro', startLine: 1, lines: [line] };
      }
    }
  }

  // Flush last section
  if (currentSection && currentSection.lines.length > 0) {
    const text = currentSection.lines.join('\n').trim();
    if (text && estimateTokens(text) > 30) {
      const subChunks = chunkByLines(text, CONFIG.maxChunkTokens, CONFIG.chunkOverlapLines);
      for (const sub of subChunks) {
        chunks.push({
          id: hashId(file.relativePath, currentSection.startLine + sub.startLine - 1),
          content: sub.text,
          filePath: file.relativePath,
          language: file.language,
          module: file.module,
          chunkType: 'section',
          symbolName: currentSection.title,
          startLine: currentSection.startLine + sub.startLine - 1,
          endLine: currentSection.startLine + sub.endLine - 1,
          lastModified: file.lastModified,
        });
      }
    }
  }

  // If no sections found, fall back
  if (chunks.length === 0) {
    return chunkFallback(file, content);
  }

  return chunks;
}

function chunkFallback(file: FileEntry, content?: string): Chunk[] {
  const text = content || fs.readFileSync(file.absolutePath, 'utf-8');
  if (!text.trim()) return [];

  const subChunks = chunkByLines(text, CONFIG.maxChunkTokens, CONFIG.chunkOverlapLines);
  return subChunks.map(sub => ({
    id: hashId(file.relativePath, sub.startLine),
    content: sub.text,
    filePath: file.relativePath,
    language: file.language,
    module: file.module,
    chunkType: 'block',
    symbolName: '',
    startLine: sub.startLine,
    endLine: sub.endLine,
    lastModified: file.lastModified,
  }));
}

export function chunkFile(file: FileEntry): Chunk[] {
  try {
    switch (file.language) {
      case 'typescript':
      case 'tsx':
      case 'javascript':
      case 'jsx':
        return chunkTypeScript(file);
      case 'markdown':
        return chunkMarkdown(file);
      default:
        return chunkFallback(file);
    }
  } catch (err) {
    console.warn(`Failed to chunk ${file.relativePath}: ${err}`);
    return chunkFallback(file);
  }
}
