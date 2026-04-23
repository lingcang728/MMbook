import { writable, derived } from 'svelte/store';
import { themes, applyTheme, type Theme } from '$lib/theme/themes';

export const currentFilePath = writable<string | null>(null);
export const markdownSource = writable<string>('');
export const renderedHtml = writable<string>('');
export const isLoading = writable<boolean>(false);

// Theme
let savedTheme: string | null = null;
try {
	savedTheme = typeof localStorage !== 'undefined' ? localStorage.getItem('mmbook-theme') : null;
} catch {
	// localStorage may be disabled or quota exceeded
}
const defaultTheme = savedTheme
	? themes.find((t) => t.name === savedTheme) || themes[0]
	: themes[0];

export const currentTheme = writable<Theme>(defaultTheme);

currentTheme.subscribe((theme) => {
	if (typeof document !== 'undefined') {
		applyTheme(theme);
		try {
			localStorage.setItem('mmbook-theme', theme.name);
		} catch {
			// localStorage may be disabled or quota exceeded — silently skip
		}
	}
});

// Focus mode
export const focusMode = writable<boolean>(false);

// Search
export const searchOpen = writable<boolean>(false);
export const searchQuery = writable<string>('');

// TOC
export const tocOpen = writable<boolean>(false);

// Settings panel
export const settingsOpen = writable<boolean>(false);
