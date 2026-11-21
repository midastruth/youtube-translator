// Display-only helpers: never change cue timings, translations or VTT exports.
export const DISPLAY_DEFAULTS = { fontSizeOrig: 18, fontSizeTran: 24, autoScale: true, fontScale: 1 };
export const DISPLAY_KEYS = ["fontSizeOrig", "fontSizeTran", "autoScale", "fontScale", "isBilingual", "origColor", "tranColor", "bgOpacity", "positionY"];
export function subtitleScale(width: number, automatic = true, manual = 1) {
  return (automatic && width > 0 ? Math.max(0.8, Math.min(1.6, width / 1280)) : 1)
    * Math.max(0.5, Math.min(2, Number.isFinite(manual) ? manual : 1));
}
