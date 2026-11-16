try {
  document.documentElement.classList.toggle('lp-dark', localStorage.getItem('lunar-dark-mode') === '1')
} catch {
  // Use the default theme when storage is unavailable.
}
