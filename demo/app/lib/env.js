// Laufzeitumgebung des Frontends. Normalerweise spricht die Oberfläche mit dem Server.
// In der statischen Demo (GitHub Pages, erkennbar am <meta name="zsp-demo">) beantwortet
// ein Simulator im Browser die API-Aufrufe, und die Adressen stehen hinter dem # (Hash-Routing).

export const DEMO = typeof document !== 'undefined' && document.querySelector('meta[name="zsp-demo"]') !== null;

                              
                                                                                                   
                            
 

let backend                     = null;
export function setDemoBackend(b             )       { backend = b; }
export function demoBackend()                     { return backend; }
