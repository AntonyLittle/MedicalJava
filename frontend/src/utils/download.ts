// Saves a blob, or the response of a same-origin URL, under the given file name.
export function download(source: Blob | string, fileName: string): void {
  const url = typeof source === 'string' ? source : URL.createObjectURL(source);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (typeof source !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._ ()-]/g, '_').trim() || 'segmentation';
}
