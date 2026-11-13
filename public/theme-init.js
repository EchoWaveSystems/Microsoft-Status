// Runs before first paint (loaded synchronously in <head>) so a saved theme doesn't flash.
// Kept out of index.html because the Content-Security-Policy forbids inline scripts.
try { const t = localStorage.getItem('msb-theme'); if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t; } catch {}
