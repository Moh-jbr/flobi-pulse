// The "Clear ↔ Tinted" glass setting (0–1) as the --glass-alpha the styles use.
// Shared by App (the saved setting) and Settings (the live preview while dragging).
export const glassAlpha = (glass) => 0.46 + glass * 0.46;

export function applyGlass(glass) {
  document.documentElement.style.setProperty('--glass-alpha', String(glassAlpha(glass)));
}
