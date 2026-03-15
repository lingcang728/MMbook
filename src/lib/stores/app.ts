import { writable, derived } from 'svelte/store';
import { themes, applyTheme, type Theme } from '$lib/theme/themes';

export const currentFilePath = writable<string | null>(null);
export const markdownSource = writable<string>('');
export const renderedHtml = writable<string>('');
export const isLoading = writable<boolean>(false);

// Theme
const savedTheme = typeof localStorage !== 'undefined' ? localStorage.getItem('mmbook-theme') : null;
const defaultTheme = savedTheme
	? themes.find((t) => t.name === savedTheme) || themes[0]
	: themes[0];

export const currentTheme = writable<Theme>(defaultTheme);

currentTheme.subscribe((theme) => {
	if (typeof document !== 'undefined') {
		applyTheme(theme);
		localStorage.setItem('mmbook-theme', theme.name);
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
