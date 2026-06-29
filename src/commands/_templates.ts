import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const TEMPLATES_DIR = path.resolve(__dirname, '..', '..', 'templates');

export function readTemplate(name: string): string {
  return fs.readFileSync(path.join(TEMPLATES_DIR, name), 'utf-8');
}
