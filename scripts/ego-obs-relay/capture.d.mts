export function capture(options: {
  taskSpace(space: number): Promise<{ page(label: string): {
    cdp(method: string, params?: object): Promise<any>;
    events(): Promise<{ method: string; params: any }[]>;
  } }>;
  space: number; page: string; endpoint: string; token: string; fps: number; width: number; quality: number;
}): Promise<void>;
