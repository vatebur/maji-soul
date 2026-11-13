/** The common page capabilities required by the game and capture adapters. */
export interface BrowserPagePort {
  evaluate(source: string | ((argument: any) => any), argument?: any): Promise<any>;
  cdp?(method: string, parameters?: any): Promise<any>;
  reload?(): Promise<any>;
}
