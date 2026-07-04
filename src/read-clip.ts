/**
 * Shared helper for fetching a line-range slice of a file.
 *
 * Used by:
 *  - `POST /read`            — raw (filePath, startLine, endLine) body
 *  - `GET|POST /clip[/...]`  — resolved from a numeric clip id
 *  - MCP `codebase_read_file` and `codebase_clip`
 *
 * Encapsulates the path-safety guard, the 25 MB file-size cap, the 500-line
 * per-call range cap, and the 1-indexed inclusive line semantics shared by
 * `/read` and `/clip`.
 *
 * Returns a discriminated union — the HTTP layer maps statusCode to a
 * response; the MCP layer maps it to `isError: true` with a text message.
 * This keeps error reporting identical across all entry points.
 */
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config.js';

export const READ_MAX_RANGE = 500;
export const READ_MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

export interface ClipSlice {
  filePath: string;
  startLine: number; // 1-indexed, inclusive, clamped to file bounds
  endLine: number; // 1-indexed, inclusive, clamped to file bounds
  totalLines: number;
  content: string;
}

export interface ClipError {
  statusCode: number;
  message: string;
}

export type ReadClipResult =
  | { ok: true; clip: ClipSlice }
  | { ok: false; error: ClipError };

function resolveSafePath(
  filePath: string,
): { ok: true; resolved: string } | { ok: false; error: ClipError } {
  if (!filePath || typeof filePath !== 'string') {
    return {
      ok: false,
      error: {
        statusCode: 400,
        message: 'filePath is required and must be a string (path relative to the workspace root)',
      },
    };
  }
  const resolved = path.resolve(CONFIG.workspaceRoot, filePath);
  const rootWithSep = CONFIG.workspaceRoot.endsWith(path.sep)
    ? CONFIG.workspaceRoot
    : CONFIG.workspaceRoot + path.sep;
  if (!resolved.startsWith(rootWithSep) && resolved !== CONFIG.workspaceRoot) {
    return {
      ok: false,
      error: {
        statusCode: 403,
        message: `filePath must be inside the workspace root (${CONFIG.workspaceRoot})`,
      },
    };
  }
  return { ok: true, resolved };
}

/**
 * Read a slice of a file between two 1-indexed inclusive line numbers.
 * Semantics match `sed -n '<start>,<end>p' <filePath>`.
 */
export async function readFileSlice(
  filePath: string,
  startLine: number,
  endLine: number,
): Promise<ReadClipResult> {
  // Validate inputs
  if (
    typeof startLine !== 'number' ||
    typeof endLine !== 'number' ||
    !Number.isFinite(startLine) ||
    !Number.isFinite(endLine)
  ) {
    return {
      ok: false,
      error: {
        statusCode: 400,
        message: 'startLine and endLine are required and must be finite numbers (1-indexed, inclusive)',
      },
    };
  }
  if (startLine < 1 || endLine < 1) {
    return {
      ok: false,
      error: { statusCode: 400, message: 'startLine and endLine must be >= 1' },
    };
  }
  if (endLine < startLine) {
    return {
      ok: false,
      error: { statusCode: 400, message: 'endLine must be >= startLine' },
    };
  }

  // Path safety
  const pathResult = resolveSafePath(filePath);
  if (!pathResult.ok) return pathResult;
  const resolved = pathResult.resolved;

  // File size guard — check before readFile so we can 413 cheaply.
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(resolved);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      return {
        ok: false,
        error: { statusCode: 404, message: `File not found: ${filePath}` },
      };
    }
    return { ok: false, error: { statusCode: 500, message: err.message } };
  }
  if (!stat.isFile()) {
    return {
      ok: false,
      error: { statusCode: 400, message: `Not a regular file: ${filePath}` },
    };
  }
  if (stat.size > READ_MAX_FILE_SIZE) {
    const sizeMb = (stat.size / 1024 / 1024).toFixed(1);
    const capMb = (READ_MAX_FILE_SIZE / 1024 / 1024).toFixed(0);
    return {
      ok: false,
      error: {
        statusCode: 413,
        message: `File too large: ${sizeMb} MB (max ${capMb} MB). Refine the search to a smaller chunk or paginate.`,
      },
    };
  }

  // Read + slice
  let content: string;
  try {
    content = await fs.promises.readFile(resolved, 'utf-8');
  } catch (err: any) {
    return { ok: false, error: { statusCode: 500, message: err.message } };
  }

  const lines = content.split('\n');
  const totalLines = lines.length;

  const start = Math.max(1, Math.floor(startLine));
  const end = Math.min(totalLines, Math.floor(endLine));

  if (end < start) {
    return {
      ok: false,
      error: {
        statusCode: 400,
        message: 'endLine must be >= startLine (after clamping to file bounds)',
      },
    };
  }

  const range = end - start + 1;
  if (range > READ_MAX_RANGE) {
    return {
      ok: false,
      error: {
        statusCode: 400,
        message: `Line range too large: ${range} lines (max ${READ_MAX_RANGE}). Narrow startLine/endLine or chain multiple reads.`,
      },
    };
  }

  // 1-indexed, inclusive — matches `sed -n '<start>,<end>p'`.
  const slice = lines.slice(start - 1, end).join('\n');

  return {
    ok: true,
    clip: {
      filePath,
      startLine: start,
      endLine: end,
      totalLines,
      content: slice,
    },
  };
}