import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = path.join(__dirname, 'templates');

const cache = new Map<string, string>();

const readTemplate = (name: string): string => {
  const cached = cache.get(name);
  if (cached !== undefined) return cached;
  const full = path.join(TEMPLATE_DIR, name);
  const contents = fs.readFileSync(full, 'utf8');
  cache.set(name, contents);
  return contents;
};

// Minimal {{ variable }} substitution. No conditionals, no loops, no escaping.
// Templates that need conditional sections should ship two separate templates.
// HTML escaping is the caller's responsibility for any user-supplied content.
export const renderString = (
  template: string,
  context: Record<string, string | number>,
): string => {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, key: string) => {
    const value = context[key];
    return value === undefined ? '' : String(value);
  });
};

export const renderTemplate = (
  templateFile: string,
  context: Record<string, string | number>,
): string => {
  return renderString(readTemplate(templateFile), context);
};

export const escapeHtml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
