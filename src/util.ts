export function isRecord(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null && !Array.isArray(obj);
}

export function stringProp(obj: unknown, key: string): string | undefined {
  if (isRecord(obj) && typeof obj[key] === 'string') {
    return obj[key] as string;
  }
  return undefined;
}

export function previewText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

export function toPosixPath(p: string): string {
  return p.replace(/\\/g, '/');
}
