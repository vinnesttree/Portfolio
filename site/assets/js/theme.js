// Runs before first paint so a saved theme choice never flashes the wrong colours.
(function () {
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (e) {
    // Storage can be unavailable (private mode, blocked cookies); fall back to the OS setting.
  }
})();
