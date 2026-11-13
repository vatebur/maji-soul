/** The common page capabilities required by the game and capture adapters. */
export interface BrowserPagePort {
  evaluate(source: string | ((argument: any) => any), argument?: any): Promise<any>;
  cdp?(method: string, parameters?: any): Promise<any>;
  /** Fresh lossless viewport pixels; adapters choose their native capture path. */
  captureViewportPng?(): Promise<{ data: string }>;
  /** Fresh, unscaled pixels at explicit viewport coordinates. Only adapters
   * that preserve their own viewport and serialize captures may provide this. */
  captureViewportPngRegion?(region: { x: number; y: number; width: number; height: number }): Promise<{ data: string }>;
  reload?(): Promise<any>;
}
