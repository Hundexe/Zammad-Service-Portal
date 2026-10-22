// Setzt das Farbschema vor dem ersten Zeichnen (kein Aufblitzen). Gespeicherte Wahl
// hat Vorrang, sonst gilt die Einstellung des Betriebssystems.
(function () {
  var t = null;
  try { t = localStorage.getItem('zsp.theme'); } catch (e) { /* privater Modus */ }
  if (t !== 'light' && t !== 'dark') t = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
})();
