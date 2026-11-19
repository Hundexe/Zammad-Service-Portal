// Setzt das Farbschema vor dem ersten Zeichnen (kein Aufblitzen). Gespeicherte Wahl
// hat Vorrang, sonst gilt die Einstellung des Betriebssystems.
(function () {
  var t = null;
  try { t = localStorage.getItem('zsp.theme'); } catch (e) { /* privater Modus */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  // Gestaltungsstil des zuletzt gewählten Ticketsystems (wird nach dem Laden bestätigt)
  var s = null;
  try { s = localStorage.getItem('zsp.style'); } catch (e) { /* privater Modus */ }
  if (s && /^[a-z]{3,20}$/.test(s)) document.documentElement.setAttribute('data-style', s);
})();
