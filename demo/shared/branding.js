// Branding pro Ticketsystem und Kontrastprüfung nach WCAG 2.1.

/** Gestaltungsstile, die pro Ticketsystem gewählt werden können. */
export const THEMES = ['standard', 'glas', 'fluent', 'material', 'kontrast']         ;
                                              

                                                                                                                    

                                                                                               

/** Stile mit ihren eigenen Farben (gelten, wenn keine eigenen Farben gewählt sind). */
export const THEME_INFO                             = {
  standard: {
    id: 'standard', name: 'Standard', description: 'Ruhig und hell, große Farbfläche, runde Formen',
    palette: { primaryColor: '#1f5fae', accentColor: '#0f8a6a', headerColor: '#13294b', headerTextColor: '#ffffff' },
  },
  glas: {
    id: 'glas', name: 'Glas', description: 'Durchscheinende Flächen mit Unschärfe über einem Farbverlauf – im Stil von Apple',
    palette: { primaryColor: '#0066cc', accentColor: '#248a3d', headerColor: '#4b3fd6', headerTextColor: '#ffffff' },
  },
  fluent: {
    id: 'fluent', name: 'Fluent', description: 'Sachlich mit kleinen Rundungen, Akzentlinien und Segoe-Schrift – im Stil von Microsoft',
    palette: { primaryColor: '#0f6cbd', accentColor: '#107c10', headerColor: '#0f548c', headerTextColor: '#ffffff' },
  },
  material: {
    id: 'material', name: 'Material', description: 'Getönte Flächen, kräftige Rundungen, gefüllte Schaltflächen – im Stil von Google',
    palette: { primaryColor: '#6750a4', accentColor: '#7d5260', headerColor: '#e8def8', headerTextColor: '#1d192b' },
  },
  kontrast: {
    id: 'kontrast', name: 'Kontrast', description: 'Klare Linien, hoher Kontrast, unterstrichene Links – besonders gut lesbar',
    palette: { primaryColor: '#003a8c', accentColor: '#006b3c', headerColor: '#000000', headerTextColor: '#ffffff' },
  },
};

/** Fertige Farbkombinationen für „eigene Farben“ (alle mit ausreichendem Kontrast). */
export const PALETTES                                       = [
  { name: 'Ozean', palette: { primaryColor: '#0369a1', accentColor: '#0d9488', headerColor: '#0c4a6e', headerTextColor: '#ffffff' } },
  { name: 'Wald', palette: { primaryColor: '#166534', accentColor: '#a16207', headerColor: '#14532d', headerTextColor: '#ffffff' } },
  { name: 'Abendrot', palette: { primaryColor: '#c2410c', accentColor: '#be185d', headerColor: '#7c2d12', headerTextColor: '#ffffff' } },
  { name: 'Beere', palette: { primaryColor: '#9d174d', accentColor: '#7c3aed', headerColor: '#4a044e', headerTextColor: '#ffffff' } },
  { name: 'Graphit', palette: { primaryColor: '#334155', accentColor: '#0369a1', headerColor: '#1e293b', headerTextColor: '#ffffff' } },
  { name: 'Sonne', palette: { primaryColor: '#a15c07', accentColor: '#b45309', headerColor: '#fde68a', headerTextColor: '#422006' } },
  { name: 'Minze', palette: { primaryColor: '#0f766e', accentColor: '#4d7c0f', headerColor: '#ccfbf1', headerTextColor: '#134e4a' } },
  { name: 'Lavendel', palette: { primaryColor: '#6d28d9', accentColor: '#c026d3', headerColor: '#ede9fe', headerTextColor: '#2e1065' } },
];

                           
                        
                  
                                                                   
                                 
                      
                       
                      
                      
                          
                                                                                             
                              
                                                                           
                             
                                                                                                                  
                                
                            
                      
                     
                                                           
                      
                                                                   
                     
                      
                      
                                                     
                         
                                                              
                          
                                                                                         
                       
 

                                                       

export const LOGO_LIMITS = { nav: { min: 20, max: 72, default: 28 }, hero: { min: 24, max: 200, default: 44 } }         ;
export const NAV_LINKS_MAX = 6;
/** Erlaubte Ziele: Web-Adressen, E-Mail, Telefon – nie javascript: o. Ä. */
export const NAV_LINK_RE = /^(https?:\/\/[^\s"'<>]+|mailto:[^\s"'<>]+|tel:[+0-9 ()\/-]+)$/i;

export const LOGIN_TITLE_DEFAULT = 'Anfragen stellen. Tickets im Blick behalten.';

export const DEFAULT_BRANDING           = {
  theme: 'standard',
  colorMode: 'custom',
  displayName: 'IT-Self-Service-Portal',
  primaryColor: '#1f5fae',
  accentColor: '#0f8a6a',
  headerColor: '#13294b',
  headerTextColor: '#ffffff',
  logoLightId: null,
  logoDarkId: null,
  logoNavDarkId: null,
  faviconId: null,
  welcomeText: 'Wie können wir helfen?',
  footerText: '',
  loginTitle: LOGIN_TITLE_DEFAULT,
  loginText: '',
  imprintUrl: '',
  privacyUrl: '',
  logoNavHeight: LOGO_LIMITS.nav.default,
  logoHeroHeight: LOGO_LIMITS.hero.default,
  navLinks: [],
};

const HEX = /^#[0-9a-fA-F]{6}$/;

export function themeOf(b                                      )          {
  return b?.theme && (THEMES                     ).includes(b.theme) ? b.theme : 'standard';
}

/** Farben, die tatsächlich gelten: die des Stils oder die eigenen. */
export function effectiveColors(b          )          {
  if (b.colorMode === 'theme') return THEME_INFO[themeOf(b)].palette;
  return { primaryColor: b.primaryColor, accentColor: b.accentColor, headerColor: b.headerColor, headerTextColor: b.headerTextColor };
}

export function isHexColor(s         )              {
  return typeof s === 'string' && HEX.test(s);
}

function channel(c        )         {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex        )         {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a        , b        )         {
  const la = luminance(a), lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Prüft die Kontraste, die im Portal wirklich vorkommen. Liefert Warnungen (kein harter Fehler). */
export function contrastWarnings(input          )           {
  const out           = [];
  const b = effectiveColors(input);
  const check = (fg        , bg        , what        ) => {
    if (!isHexColor(fg) || !isHexColor(bg)) return;
    const r = contrastRatio(fg, bg);
    if (r < 4.5) out.push(`${what}: Kontrast ${r.toFixed(2)}:1 – WCAG AA verlangt mindestens 4,5:1`);
  };
  check(b.headerTextColor, b.headerColor, 'Farbfläche (Text auf Hintergrund)');
  check('#ffffff', b.primaryColor, 'Schaltflächen (weißer Text auf Primärfarbe)');
  check(b.primaryColor, '#ffffff', 'Links (Primärfarbe auf Weiß)');
  return out;
}

export function validateBranding(input         )                                            {
  const errors           = [];
  if (!input || typeof input !== 'object') return { errors: ['Branding fehlt'] };
  const i = input                           ;
  const str = (k        , max        , required = false)         => {
    const v = i[k];
    if (v === undefined || v === null || v === '') { if (required) errors.push(`${k} fehlt`); return ''; }
    if (typeof v !== 'string' || v.length > max) { errors.push(`${k} ungültig`); return ''; }
    return v;
  };
  const color = (k        )         => {
    const v = i[k];
    if (!isHexColor(v)) { errors.push(`${k}: Farbe im Format #rrggbb`); return '#000000'; }
    return v.toLowerCase();
  };
  const url = (k        )         => {
    const v = str(k, 500);
    if (v && !/^https:\/\/[^\s"'<>]+$/.test(v)) errors.push(`${k}: nur https-Links`);
    return v;
  };
  const id = (k        )                => {
    const v = i[k];
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v)) { errors.push(`${k} ungültig`); return null; }
    return v;
  };
  const size = (k        , lim                                               )         => {
    const v = i[k];
    if (v === undefined || v === null || v === '') return lim.default;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < lim.min || v > lim.max) { errors.push(`${k}: ${lim.min}–${lim.max} Pixel`); return lim.default; }
    return v;
  };
  const navLinks            = [];
  if (i.navLinks !== undefined && i.navLinks !== null) {
    if (!Array.isArray(i.navLinks) || i.navLinks.length > NAV_LINKS_MAX) errors.push(`navLinks: höchstens ${NAV_LINKS_MAX} Links`);
    else for (const [n, l] of i.navLinks.entries()) {
      const o = (l && typeof l === 'object' ? l : {})                           ;
      const label = typeof o.label === 'string' ? o.label.trim() : '';
      const url = typeof o.url === 'string' ? o.url.trim() : '';
      if (!label || label.length > 40) { errors.push(`Link ${n + 1}: Bezeichnung fehlt oder zu lang (max. 40 Zeichen)`); continue; }
      if (url.length > 500 || !NAV_LINK_RE.test(url)) { errors.push(`Link ${n + 1}: nur https://, http://, mailto: oder tel:`); continue; }
      navLinks.push({ label, url });
    }
  }
  const theme = i.theme === undefined || i.theme === null || i.theme === '' ? 'standard' : i.theme;
  if (typeof theme !== 'string' || !(THEMES                     ).includes(theme)) errors.push('theme: unbekannter Stil');
  const colorMode = i.colorMode === undefined || i.colorMode === null || i.colorMode === '' ? 'custom' : i.colorMode;
  if (colorMode !== 'theme' && colorMode !== 'custom') errors.push('colorMode: theme oder custom');
  const branding           = {
    theme: theme           ,
    colorMode: colorMode                      ,
    displayName: str('displayName', 80, true),
    primaryColor: color('primaryColor'),
    accentColor: color('accentColor'),
    headerColor: color('headerColor'),
    headerTextColor: color('headerTextColor'),
    logoLightId: id('logoLightId'),
    logoDarkId: id('logoDarkId'),
    logoNavDarkId: id('logoNavDarkId'),
    faviconId: id('faviconId'),
    welcomeText: str('welcomeText', 500),
    footerText: str('footerText', 500),
    loginTitle: str('loginTitle', 120),
    loginText: str('loginText', 300),
    imprintUrl: url('imprintUrl'),
    privacyUrl: url('privacyUrl'),
    logoNavHeight: size('logoNavHeight', LOGO_LIMITS.nav),
    logoHeroHeight: size('logoHeroHeight', LOGO_LIMITS.hero),
    navLinks,
  };
  return { branding: errors.length ? undefined : branding, errors };
}
