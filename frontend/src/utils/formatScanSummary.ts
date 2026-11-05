import type { ScanResult } from '../api/types';

export function formatScanSummary(scan: ScanResult | null): string {
  if (!scan) return 'No scan has run since the server started.';
  return `${scan.imported} imported, ${scan.updated} updated, ${scan.unchanged} unchanged, `
    + `${scan.excluded} previously deleted, ${scan.failed} failed`;
}
