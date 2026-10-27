// Laufzeitumgebung des Frontends. Normalerweise spricht die Oberfläche mit dem Server.
// In der statischen Demo (GitHub Pages, erkennbar am <meta name="zsp-demo">) beantwortet
// ein Simulator im Browser die API-Aufrufe, und die Adressen stehen hinter dem # (Hash-Routing).

export const DEMO = typeof document !== 'undefined' && document.querySelector('meta[name="zsp-demo"]') !== null;

export interface DemoBackend {
  request(method: string, path: string, body: unknown): Promise<{ status: number; data: unknown }>;
  asset(id: string): string;
}

let backend: DemoBackend | null = null;
export function setDemoBackend(b: DemoBackend): void { backend = b; }
export function demoBackend(): DemoBackend | null { return backend; }
