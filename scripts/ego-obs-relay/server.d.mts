export interface RelayStats {
  space: number; page: string; sequence: number; bytes: number; fps: number;
  frameAgeMs: number | null; dimensions: { width: number; height: number } | null;
  clients: number; workerExit: string | { code: number | null; signal: string | null } | null; running: boolean;
}
export function startRelay(options: { space: number; page: string; port: number; fps: number; width: number; quality: number; capture?: boolean }): Promise<{
  address: string; token: string; close(): Promise<void>; stats(): RelayStats;
}>;
export function jpegSize(buffer: Buffer): { width: number; height: number } | null;
