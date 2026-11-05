// Expands a drag-and-drop payload into files, walking dropped folders recursively (DICOM series are usually
// delivered as a folder of extension-less files). Hidden files such as .DS_Store are skipped.
export async function filesFromDrop(dataTransfer: DataTransfer): Promise<File[]> {
  // Entries must be captured synchronously: the DataTransfer is cleared once the event handler yields.
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry());

  if (entries.every((entry) => entry == null)) return visibleFiles(Array.from(dataTransfer.files));

  const files: File[] = [];
  for (const entry of entries) {
    if (entry) await collect(entry, files);
  }
  return visibleFiles(files);
}

export function visibleFiles(files: File[]): File[] {
  return files.filter((file) => !file.name.startsWith('.'));
}

async function collect(entry: FileSystemEntry, files: File[]): Promise<void> {
  if (isFile(entry)) {
    files.push(await new Promise<File>((resolve, reject) => entry.file(resolve, reject)));
  } else if (isDirectory(entry)) {
    for (const child of await readAllEntries(entry.createReader())) await collect(child, files);
  }
}

// readEntries returns results in batches (100 in Chrome) and an empty batch at the end.
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}

function isFile(entry: FileSystemEntry): entry is FileSystemFileEntry {
  return entry.isFile;
}

function isDirectory(entry: FileSystemEntry): entry is FileSystemDirectoryEntry {
  return entry.isDirectory;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}
