// One small icon per mod: a one-cell glyph for the terminal, a 24-unit line drawing for the desktop.

export const GLYPH: Record<string, string> = {
  gauge: '◔',
  clock: '◷',
  arrow: '→',
  shield: '◈',
  pencil: '✎',
  loop: '↻',
  tray: '▭',
  sliders: '☰',
  clipboard: '▤',
  branch: '⑂',
  cloud: '☁',
  puzzle: '◆',
}

// Stroke paths on a 24 x 24 grid, drawn with the current colour.
const PATH: Record<string, string> = {
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-5"/>',
  clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 6l6 6-6 6"/>',
  shield: '<path d="M12 3l7 3v5c0 5-3 8-7 10-4-2-7-5-7-10V6z"/>',
  pencil: '<path d="M5 19l1-4 10-10 3 3-10 10z"/><path d="M14 7l3 3"/>',
  loop: '<path d="M5 11a7 7 0 0 1 12-4l2 2"/><path d="M19 4v5h-5"/><path d="M19 13a7 7 0 0 1-12 4l-2-2"/><path d="M5 20v-5h5"/>',
  tray: '<path d="M4 13l2-7h12l2 7v5H4z"/><path d="M4 13h5l1 2h4l1-2h5"/>',
  sliders: '<path d="M6 4v16M12 4v16M18 4v16"/><path d="M4 9h4M10 15h4M16 8h4"/>',
  clipboard: '<rect x="6" y="5" width="12" height="16" rx="2"/><path d="M9 5V3h6v2"/><path d="M9 11h6M9 15h6"/>',
  branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="9" r="2"/><path d="M7 8v8"/><path d="M17 11c0 4-6 3-10 5"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 11a3.5 3.5 0 0 1-.5 7z"/>',
  puzzle: '<path d="M5 9h4a2 2 0 1 1 4 0h4v4a2 2 0 1 0 0 4v2H5z"/>',
}

export const iconSvg = (icon: string, color: string, size = 20): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${PATH[icon] ?? PATH.puzzle ?? ''}</svg>`
