// Runs before the page paints: saved theme, else the visitor's system setting.
// Also hides the header/footer when embedded with ?embed=1.
(() => {
  let theme = null;
  try { theme = localStorage.getItem("showcase-theme"); } catch {}
  if (theme !== "light" && theme !== "dark") theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  if (new URLSearchParams(location.search).has("embed")) document.documentElement.classList.add("embed");
})();
