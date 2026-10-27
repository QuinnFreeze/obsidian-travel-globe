export type ThemePreference='auto'|'light'|'dark';
export type ResolvedTheme='light'|'dark';

/** Obsidian's current appearance, rather than the operating system preference. */
export function applyTheme(element:HTMLElement,preference:ThemePreference):ResolvedTheme{
 const theme=preference==='auto'?(element.ownerDocument.body.classList.contains('theme-dark')?'dark':'light'):preference;
 element.dataset.tgTheme=theme;element.dataset.tgThemePreference=preference;
 return theme;
}
