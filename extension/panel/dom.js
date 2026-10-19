// Petits outils DOM partagés par les vues du panneau.

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function button(label, className, onClick, attrs = {}) {
  const b = el("button", className, label);
  b.type = "button";
  if (onClick) b.addEventListener("click", onClick);
  for (const [k, v] of Object.entries(attrs)) b.setAttribute(k, v);
  return b;
}

// Pictogrammes au trait, 16 px, dessinés pour le panneau (currentColor).
const PATHS = {
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
  play: '<path d="M5.5 3.8v8.4L12.2 8z" fill="currentColor" stroke="none"/>',
  pause: '<path d="M5.5 4v8M10.5 4v8"/>',
  eye: '<path d="M1.8 8s2.3-4.2 6.2-4.2S14.2 8 14.2 8s-2.3 4.2-6.2 4.2S1.8 8 1.8 8z"/><circle cx="8" cy="8" r="1.8"/>',
  close: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  copy: '<rect x="5.5" y="5.5" width="7" height="7" rx="1.5"/><path d="M10.5 5.5V4a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/>',
  tabs: '<rect x="2" y="4.5" width="12" height="9" rx="1.5"/><path d="M2 7.5h12M5 4.5V3h4v1.5"/>',
  hand: '<path d="M5.5 8V3.8a1 1 0 0 1 2 0V7.5M7.5 7V3a1 1 0 0 1 2 0v4M9.5 7.2V4a1 1 0 0 1 2 0v5.5c0 2.5-1.6 4-4 4-1.6 0-2.7-.8-3.6-2.2L2.6 9a1 1 0 0 1 1.6-1.1L5.5 9.3"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="M7.3 8.7L13 3M11 5l1.5 1.5M9.5 6.5l1 1"/>',
  trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.2a1 1 0 0 0 1 .8h3.8a1 1 0 0 0 1-.8l.6-8.2"/>',
  refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.8v2.6h-2.6"/>',
  message: '<path d="M3 3h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7.5L4.5 13.5V11H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/>',
};

export function icon(name, className = "icon") {
  const span = el("span", className);
  span.setAttribute("aria-hidden", "true");
  span.innerHTML = `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${PATHS[name] ?? ""}</svg>`;
  return span;
}

/** Bouton pictogramme avec un libellé accessible (et une infobulle). */
export function iconButton(name, label, onClick, className = "icon-button") {
  const b = button(null, className, onClick, { "aria-label": label, title: label });
  b.append(icon(name));
  return b;
}

export const clock = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

export async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/** Petit message éphémère en bas du panneau (« Copié », « Onglets fermés »). */
let toastTimer = null;
export function toast(text) {
  const node = $("toast");
  if (!node) return;
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 2200);
}
