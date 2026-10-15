import { extname } from 'node:path';
/**
 * The MCP server runs inside WSL while editors on Windows send Windows paths.
 * \\wsl.localhost\<distro>\home\x and \\wsl$\<distro>\home\x -> /home/x; C:\x -> /mnt/c/x.
 */
export function toLocalPath(input: string): string {
  const path = input.trim().replace(/\\/g, '/');
  const wsl = /^\/\/(?:wsl\.localhost|wsl\$)\/[^/]+(\/.*)?$/i.exec(path);
  if (wsl) return wsl[1] || '/';
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(path);
  if (drive) return `/mnt/${drive[1].toLowerCase()}${drive[2] ?? ''}`;
  if (path.startsWith('/')) return path;
  throw new Error(`Use an absolute path: ${input}`);
}
const types: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.sql': 'text/plain',
  '.zip': 'application/zip',
};
export function contentType(path: string) {
  return types[extname(path).toLowerCase()] ?? 'application/octet-stream';
}
