import fs from 'fs';
import { createRequire } from 'module';
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

export function chunkByLines(content: string, maxTokens: number, overlap: number): { text: string; startLine: number; endLine: number }[] {
  const lines = content.split('\n');
  const chunks: { text: string; startLine: number; endLine: number }[] = [];

  let start = 0;
  let prevEnd = 0;
  while (start < lines.length) {
    let end = start;
    let text = '';

    while (end < lines.length) {
      const nextLine = lines[end] + '\n';
      if (estimateTokens(text + nextLine) > maxTokens && text.length > 0) break;
      text += nextLine;
      end++;
    }

    // A window that ends where the previous one ended is a strict subset of it. That
    // happens whenever a chunk holds <= `overlap` lines (e.g. long markdown table rows):
    // `end - overlap` lands at or behind `start`, the `start + 1` guard wins, and the
    // window crawls forward one line at a time re-emitting near-identical text, which
    // then ties on score and crowds out every other search result. Restart at the
    // previous end with no overlap instead; the rebuilt window always takes >= 1 new line.
    if (end <= prevEnd && start < prevEnd) {
      start = prevEnd;
      continue;
    }
    prevEnd = end;

    if (text.trim()) {
      chunks.push({
        text: text.trimEnd(),
        startLine: start + 1,
        endLine: end,
      });
    }

    // Never overlap more than half the chunk just emitted: with long lines a chunk can hold
    // fewer lines than `overlap`, and a full overlap then re-emits most of it every step.
    const effectiveOverlap = Math.min(overlap, Math.floor((end - start) / 2));
    start = Math.max(start + 1, end - effectiveOverlap);
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

// ───────────────────────────── C++ (tree-sitter) ─────────────────────────────
//
// ts-morph parses TypeScript only, so C++ gets its own tree-sitter path. Without
// it, `chunkFallback()`'s line window cuts mid-function: rippled's
// SponsorshipTransfer.cpp produced a 1-109 chunk that ended inside
// `SponsorshipTransfer::preflight`, roughly 90 lines before that function's real
// end, so a hit's startLine landed on a body statement instead of a declaration.

/** The slice of the tree-sitter node API this module uses. */
interface TsNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  isNamed: boolean;
  hasError: boolean;
  children: TsNode[];
}

interface TsParser {
  parse(
    source: string,
    oldTree?: null,
    options?: { bufferSize?: number },
  ): { rootNode: TsNode };
  setLanguage(language: TsLanguage): void;
}

interface TsLanguage {
  name?: string;
}

/**
 * The native grammar + parser are loaded on first C++ chunk, never at import
 * time. Most consumers of this package are TypeScript projects that never touch
 * a `.cpp` file, and `tree-sitter` is a native addon: importing it eagerly
 * would load a `.node` binary for nothing and turn an optional grammar into a
 * hard startup dependency.
 */
let cppParser: TsParser | null = null;
let cppLoadAttempted = false;

function loadCppParser(): TsParser | null {
  if (!cppLoadAttempted) {
    cppLoadAttempted = true;
    try {
      const requireCjs = createRequire(import.meta.url);
      const Parser = requireCjs('tree-sitter');
      const Cpp: TsLanguage = requireCjs('tree-sitter-cpp');
      const parser: TsParser = new Parser();
      parser.setLanguage(Cpp);
      cppParser = parser;
    } catch (err) {
      // Log once. A missing or unloadable grammar must degrade to the line
      // chunker, never abort an index run.
      console.warn(
        `C++ AST chunking unavailable (tree-sitter-cpp not loadable: ${err}). Falling back to line-window chunking for .cpp/.h/.hpp/.cc/.cxx/.ipp files.`,
      );
    }
  }
  return cppParser;
}

/**
 * True for nodes that group other declarations rather than being one themselves.
 * These are always descended into. Treating one as a unit is what the old line
 * chunker effectively did: a `namespace ripple { … }` spanning a whole file became
 * a single blob that hid every symbol inside it and still got split mid-function.
 * `ERROR` belongs here too — tree-sitter parks the healthy declarations that follow
 * a syntax error inside the ERROR node, so descending is what recovers them.
 */
const CPP_CONTAINERS = new Set([
  'namespace_definition',
  'preproc_if',
  'preproc_ifdef',
  'preproc_else',
  'preproc_elif',
  'linkage_specification',
  'ERROR',
]);

/**
 * Pure nesting introduced by the grammar, never a unit. `declaration_list` is the
 * `{ … }` body of a namespace or preprocessor block: it is descended through
 * without comment, because emitting it would shadow the namespace that owns it.
 */
const CPP_TRANSPARENT = new Set(['declaration_list']);

/** How each top-level declaration maps onto the existing chunkType vocabulary. */
const CPP_UNIT_TYPES: Record<string, string> = {
  function_definition: 'function',
  class_specifier: 'class',
  struct_specifier: 'class',
  union_specifier: 'class',
  enum_specifier: 'enum',
  template_declaration: 'template',
  preproc_function_def: 'macro',
  preproc_def: 'macro',
};

/** Names a declaration can introduce, and how to find them. */
const TYPE_NAME_NODES = new Set(['type_identifier', 'namespace_identifier']);
const VALUE_NAME_NODES = new Set([
  'identifier',
  'field_identifier',
  'qualified_identifier',
  'operator_name',
  'destructor_name',
]);
/**
 * Variable names only. `qualified_identifier` is excluded on purpose: for
 * `std::vector<int> v;` it is the type and it appears before the variable, so a
 * BFS would otherwise name the chunk `std::vector<int>`. Function names do allow
 * it — `Foo::bar(int);` is a prototype whose declarator is qualified.
 */
const VARIABLE_NAME_NODES = new Set(['identifier', 'field_identifier']);

/**
 * Subtrees that can contain identifiers which are not the declared symbol.
 * Without this, `int add(T a, T b)` would be named after its first parameter.
 */
const NAME_SEARCH_SKIP = new Set([
  'parameter_list',
  'field_declaration_list',
  'template_parameter_list',
  'type_parameter_declaration',
  'preproc_params',
  'enumerator_list',
  'field_declaration',
  'base_class_clause',
  'condition_clause',
]);

/**
 * Breadth-first search for a declared symbol name: shallowest match wins, so
 * `class Holder` yields `Holder` rather than something from its base clause, and
 * `SponsorshipTransfer::preflight(…)` yields the qualified name rather than an
 * argument. `accept` decides which node kinds count as names for this unit.
 */
function findSymbolName(node: TsNode, accept: Set<string>): string {
  const queue: TsNode[] = [node];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current !== node && accept.has(current.type)) return current.text;
    for (const child of current.children) {
      if (NAME_SEARCH_SKIP.has(child.type)) continue;
      queue.push(child);
    }
  }
  return '';
}

/**
 * The node that actually carries a function's name.
 *
 * Both `declaration` (a prototype) and `function_definition` put the return
 * type first, and tree-sitter-cpp parses a qualified return type — `std::uint32_t`,
 * `std::optional<NotTEC>`, `std::pair<TER, XRPAmount>` — as a single
 * `qualified_identifier`, which `VALUE_NAME_NODES` accepts. A BFS from the
 * declaration root therefore reaches the return type one level before it reaches
 * the declarator and names the chunk after the *type*. Searching from the
 * declarator is what keeps the name on the function: `Transactor::reset`, not
 * `std::pair<TER, XRPAmount>`.
 */
function functionDeclarator(node: TsNode): TsNode | undefined {
  return node.children.find(
    (c) => c.type === 'function_declarator' || c.type === 'operator_name',
  );
}

/**
 * Classify a node that declares something, returning the chunkType and symbol
 * name. Unknown nodes return an empty type so callers can skip them.
 */
function cppUnitKind(node: TsNode): { type: string; name: string } {
  // A `declaration` at namespace scope is either a function prototype or a
  // variable. Prototypes are the bulk of a C++ header, and calling them
  // `variable` would mis-type most of what a header contains. A
  // `function_definition` needs the same declarator-first search, for the
  // return-type reason above; the generic arm below would not do it.
  if (node.type === 'declaration' || node.type === 'function_definition') {
    const declarator = functionDeclarator(node);
    if (declarator) {
      return { type: 'function', name: findSymbolName(declarator, VALUE_NAME_NODES) };
    }
    // A `declaration` with no declarator is a variable. A `function_definition`
    // with no declarator falls through to the generic arm below unchanged.
    if (node.type === 'declaration') {
      return { type: 'variable', name: findSymbolName(node, VARIABLE_NAME_NODES) };
    }
  }

  const declared = CPP_UNIT_TYPES[node.type];
  if (!declared) return { type: '', name: '' };

  const name =
    node.type === 'class_specifier' ||
    node.type === 'struct_specifier' ||
    node.type === 'union_specifier' ||
    node.type === 'enum_specifier' ||
    node.type === 'namespace_definition'
      ? findSymbolName(node, TYPE_NAME_NODES)
      : findSymbolName(node, VALUE_NAME_NODES);
  return { type: declared, name };
}

/**
 * `template <typename T> T add(…)` is a function and a class is a class; only
 * the wrapper is special. Resolve the template's payload so the chunk is typed by
 * what it actually declares while its text still keeps the `template<…>` header.
 * An explicit specialisation (`template <> void f<int>(…)`) parses as a bare
 * function_definition, which the default arm already handles.
 */
function resolveTemplate(node: TsNode): { type: string; name: string; node: TsNode } {
  for (const child of node.children) {
    if (child.type === 'template_parameter_list') continue;
    const kind = cppUnitKind(child);
    if (kind.type) {
      // The template node itself is the unit, not the payload, so the chunk keeps
      // its `template <…>` header; it is simply typed and named as what it declares.
      return { type: kind.type, name: kind.name, node };
    }
  }
  return { type: 'template', name: '', node };
}

interface CppUnit {
  text: string;
  type: string;
  name: string;
  startLine: number;
  endLine: number;
}

function toUnit(node: TsNode, chunkType: string, name: string): CppUnit {
  return {
    text: node.text.trim(),
    type: chunkType,
    name,
    startLine: node.startPosition.row + 1,
    // `endPosition.row` is the row the node's last character sits on, EXCEPT when
    // the text ends in a newline: that newline is the last character, so the node
    // technically ends on the *next* row while owning nothing there. Every
    // preprocessor directive is shaped this way — `#define X 1\n` spans rows 28-29
    // for a one-line macro on row 28 — so trusting `row + 1` claims a line the
    // macro does not contain. Two adjacent `#define`s then both claim the shared
    // boundary line and overlap by one. `text` is already trimmed, so testing the
    // node's own text is the exact check for "ends in a newline".
    endLine:
      node.text.endsWith('\n') ? node.endPosition.row : node.endPosition.row + 1,
  };
}

function collectCppUnits(node: TsNode, units: CppUnit[], depth = 0): void {
  for (const child of node.children) {
    if (!child.isNamed) continue;

    if (child.type === 'template_declaration') {
      const resolved = resolveTemplate(child);
      units.push(toUnit(resolved.node, resolved.type, resolved.name));
      continue;
    }

    const kind = cppUnitKind(child);
    if (kind.type) {
      units.push(toUnit(child, kind.type, kind.name));
      continue;
    }

    if (CPP_TRANSPARENT.has(child.type)) {
      if (depth < 64) collectCppUnits(child, units, depth + 1);
      continue;
    }

    if (CPP_CONTAINERS.has(child.type)) {
      // Containers are always walked, never stored verbatim. A `namespace ripple {…}`
      // holding several functions is not one unit, and storing it whole is exactly
      // the blob this path replaces — it dilutes the embedding and hides every
      // symbol inside it. Storing it only when it fits `maxChunkTokens` was worse
      // than useless: a whole small namespace collapsed into one unsplittable chunk.
      if (depth >= 64) continue;
      const before = units.length;
      collectCppUnits(child, units, depth + 1);
      if (units.length === before) {
        // Nothing recognisable inside (a namespace of `using` directives, a broken
        // region). Store it so its text is not silently dropped from the index.
        const type = child.type === 'namespace_definition' ? 'namespace' : 'block';
        const name = type === 'namespace' ? findSymbolName(child, TYPE_NAME_NODES) : '';
        units.push(toUnit(child, type, name));
      }
    }
  }
}

/**
 * `tree-sitter@0.21.1` cannot read a source file in pieces.
 *
 * Its native read callback (`CallbackInput::Read` in the binding's `parser.cc`)
 * copies the string the JS input callback hands it into a fixed `uint16_t`
 * buffer via `napi_get_value_string_utf16`. That buffer defaults to
 * `32 * 1024` **UTF-16 code units**, so the largest source the binding can read
 * in one go is 32767 units. Anything longer makes the copy fail with
 * `napi_invalid_arg`; the read callback then returns `nullptr`, and the
 * pending exception surfaces in JS as a bare `Error: Invalid argument`.
 *
 * The binding does carry a `partial_string` continuation path for reads that
 * span several chunks, but it sits *after* that same copy call and is
 * unreachable: the copy fails first. Measured on the installed binding, every
 * `bufferSize` below `source.length + 1` throws, for any file size, and the
 * failure is not a parse error — the same file parses once the buffer is big
 * enough.
 *
 * `bufferSize` is the binding's own documented option for this, so the fix is
 * to size the buffer to the content rather than to split the file. Splitting is
 * the tempting alternative and the wrong one: a C++ split can land mid-
 * declaration, and merging the two ASTs would have to repair it. Passing the
 * whole source also keeps `node.text` exact — it is sliced from the original
 * string by byte offset, so a re-joined, offset-shifted source would return
 * subtly wrong text instead of failing loudly.
 *
 * `length` (UTF-16 code units) is the unit the native buffer is measured in, so
 * that is what sizes it. The `+ 1` is the NUL terminator
 * `napi_get_value_string_utf16` requires.
 */
function cppReadBufferSize(content: string): number {
  return content.length + 1;
}

function chunkCpp(file: FileEntry): Chunk[] {
  const content = fs.readFileSync(file.absolutePath, 'utf-8');
  const parser = loadCppParser();
  if (!parser) return chunkFallback(file, content);

  try {
    const root = parser.parse(content, null, {
      bufferSize: cppReadBufferSize(content),
    }).rootNode;
    if (!root) return chunkFallback(file, content);

    const units: CppUnit[] = [];
    collectCppUnits(root, units);

    // Nothing recognisable (an empty file, or one that is all comments) — defer to
    // the line chunker exactly as chunkTypeScript() does for a symbol-less file.
    if (units.length === 0) return chunkFallback(file, content);

    const lines = content.split('\n');
    const chunks: Chunk[] = [];
    const push = (
      text: string,
      chunkType: string,
      symbolName: string,
      startLine: number,
      endLine: number,
    ) => {
      chunks.push({
        id: hashId(file.relativePath, startLine),
        content: text,
        filePath: file.relativePath,
        language: file.language,
        module: file.module,
        chunkType,
        symbolName,
        startLine,
        endLine,
        lastModified: file.lastModified,
      });
    };

    // Includes, `#pragma once` and the opening namespace — whatever precedes the
    // first declaration, mirroring chunkTypeScript()'s file-header chunk.
    if (units[0].startLine > 1) {
      const headerText = lines.slice(0, units[0].startLine - 1).join('\n').trim();
      if (headerText && estimateTokens(headerText) > 50) {
        push(headerText, 'imports', 'file-header', 1, units[0].startLine - 1);
      }
    }

    for (const unit of units) {
      const nodeText = unit.text;
      if (!nodeText) continue;

      if (estimateTokens(nodeText) <= CONFIG.maxChunkTokens) {
        push(nodeText, unit.type, unit.name, unit.startLine, unit.endLine);
      } else {
        // Oversized unit — subdivide so it does not overflow the embed, but with a
        // ZERO line overlap, unlike every other caller of chunkByLines().
        //
        // The overlap exists for contextless line chunking: a window that starts
        // mid-function carries nothing to identify it, so re-emitting a few
        // leading lines gives the embedder something to anchor on. Here that
        // reasoning does not apply. The windows are cut from ONE unit whose
        // symbol, type and exact boundaries are already known, so re-emitting the
        // boundary lines buys no context — it just stores the same source twice.
        //
        // Measured on rippled, that duplication is the whole of Defect 1: of 693
        // overlapping chunk pairs across 350 files, 449 were exactly
        // `chunkOverlapLines` wide between chunks of the SAME symbol, produced
        // here. rippled's SponsorshipTransfer.cpp `doApply` (243 lines) became
        // four chunks overlapping 78 line-slots, so its overlap region was
        // embedded five times over. Those near-identical vectors tie on score and
        // crowd out every other hit for the function.
        //
        // Zero overlap still emits every line exactly once — chunkByLines
        // advances `start` to `end`, so the windows tile the unit with no gap and
        // no content is dropped.
        for (const sub of chunkByLines(nodeText, CONFIG.maxChunkTokens, 0)) {
          push(
            sub.text,
            unit.type,
            unit.name,
            unit.startLine + sub.startLine - 1,
            unit.startLine + sub.endLine - 1,
          );
        }
      }
    }

    return chunks;
  } catch (err) {
    // tree-sitter is error-tolerant, but a malformed file must never abort a run.
    console.warn(`C++ AST parse failed for ${file.relativePath}: ${err}`);
    return chunkFallback(file, content);
  }
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
      case 'cpp':
        return chunkCpp(file);
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
