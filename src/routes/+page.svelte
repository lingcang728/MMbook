<script lang="ts">
	import { onMount, tick } from "svelte";
	import { invoke } from "@tauri-apps/api/core";
	import { listen } from "@tauri-apps/api/event";
	import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
	import { open } from "@tauri-apps/plugin-dialog";
	import { openUrl } from "@tauri-apps/plugin-opener";
	import { check } from "@tauri-apps/plugin-updater";
	import type { RenderedMarkdownDocument, TocItem } from "$lib/render/markdown";
	import {
		currentFilePath,
		markdownSource,
		renderedHtml,
		isLoading,
		currentTheme,
		focusMode,
		searchOpen,
		searchQuery,
		tocOpen,
		settingsOpen,
	} from "$lib/stores/app";
	import { getThemePairs } from "$lib/theme/themes";

	let contentEl: HTMLElement;
	let searchInput: HTMLInputElement;
	let tocItems: TocItem[] = [];
	let fileName = "";
	let fileEncoding = 'utf-8';
	let fileError = "";
	type SearchMatch = {
		block: HTMLElement;
		occurrence: number;
	};
	let searchMatches: SearchMatch[] = [];
	let currentMatchIndex = -1;
	let currentSearchMark: HTMLElement | null = null;
	let editingParagraph: HTMLElement | null = null;
	let originalText = "";
	let originalTextContent = "";
	let focusBlocks: HTMLElement[] = [];
	let focusBlockMetrics: { top: number; bottom: number; center: number }[] = [];
	let focusMetricsValid = false;
	let focusUpdateFrame: number | null = null;
	let queuedFocusIndex: number | undefined;
	let isFocusScrollActive = false;
	let isFocusKeyScrollActive = false;
	let focusScrollEndTimer: ReturnType<typeof setTimeout> | null = null;
	let focusLockedIndex: number | null = null;
	let focusProgrammaticScrollIndex: number | null = null;
	let focusProgrammaticScrollTarget: number | null = null;
	let focusProgrammaticScrollTimer: ReturnType<typeof setTimeout> | null = null;
	let focusKeyScrollDirection: -1 | 0 | 1 = 0;
	let focusKeyScrollFrame: number | null = null;
	let focusKeyScrollLastTime = 0;
	let focusKeyReadableTimer: ReturnType<typeof setTimeout> | null = null;
	let focusInlineScrollBehavior: string | null = null;
	let focusTapDirection: -1 | 0 | 1 = 0;
	let focusTapTimes: number[] = [];
	let focusRapidTapActiveUntil = 0;
	let searchMatchBlocks = new Set<HTMLElement>();
	let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
	let currentLoadToken: string = '';
	let finishEditPromise: Promise<boolean> | null = null;
	let lastFocusRenderSignature = "";
	let focusStyleCache = new WeakMap<HTMLElement, string>();
	let lastFocusStyleIndices = new Set<number>();
	let lastFocusStyleTheme = "";
	let lastFocusSearchIndex = -1;
	let lastFocusStyleKeyScrollActive = false;
	let lastSpotlightVars = new Map<string, string>();
	let markdownWorker: Worker | null = null;
	let markdownWorkerFailed = false;
	let nextRenderRequestId = 1;
	const pendingMarkdownRenders = new Map<number, {
		resolve: (result: RenderedMarkdownDocument) => void;
		reject: (error: Error) => void;
	}>();
	let spotlightHeight = 100;

	let isEditingInDarkFocus = false;
	let editOrbitContainerStyle = '';
	const EDIT_ORBIT_COUNT = 20;
	let editOrbitParticles: {id: number, size: number, duration: number, opacity: number, stagger: number}[] = [];

	let particles: {id: number, left: number, size: number, duration: number, delay: number, opacity: number}[] = [];
	let isLightTheme = false;

	const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
	const modLabel = isMac ? '⌘' : 'Ctrl+';
	function isModKey(e: KeyboardEvent): boolean {
		return isMac ? e.metaKey : e.ctrlKey;
	}

	$: isLightTheme = $currentTheme.name.toLowerCase().includes('light');
	$: if ($focusMode && !isLightTheme && typeof window !== "undefined") {
		if (particles.length === 0) {
			particles = Array.from({length: 80}).map((_, i) => ({
				id: i,
				left: Math.random() * 100,
				size: Math.random() * 2 + 1,
				duration: Math.random() * 12 + 6,
				delay: Math.random() * -20,
				opacity: Math.random() * 0.7 + 0.3
			}));
		}
	} else {
		particles = [];
	}
	$: if (!editingParagraph && isEditingInDarkFocus) cleanupEditOrbit();

	let readingProgress = 0;
	const FOCUS_ANCHOR_RATIO = 0.5;
	const FOCUS_EDGE_SPACE_RATIO = 0.34;
	const FOCUS_EDGE_SPACE_MIN = 140;
	const FOCUS_WHEEL_STEP = 48;
	const FOCUS_SCROLL_ACTIVE_MS = 120;
	const FOCUS_LONG_BLOCK_RATIO = 0.78;
	const FOCUS_LONG_BLOCK_EDGE_RATIO = 0.12;
	const FOCUS_LONG_BLOCK_EDGE_MIN = 48;
	const FOCUS_LONG_BLOCK_EDGE_MAX = 140;
	const FOCUS_SPOTLIGHT_MAX_RATIO = 0.62;
	const FOCUS_SPOTLIGHT_MIN = 48;
	const FOCUS_PROGRAMMATIC_SCROLL_SETTLE_MS = 180;
	const FOCUS_KEY_SCROLL_RATIO = 1.26;
	const FOCUS_KEY_SCROLL_MIN_SPEED = 780;
	const FOCUS_KEY_SCROLL_MAX_SPEED = 1260;
	const FOCUS_KEY_SCROLL_MAX_FRAME_MS = 50;
	const FOCUS_KEY_HOLD_TICK_MS = 33;
	const FOCUS_RAPID_TAP_RESET_MS = 520;
	const FOCUS_RAPID_TAP_WINDOW_MS = 680;
	const FOCUS_RAPID_TAP_MIN_COUNT = 3;
	const FOCUS_RAPID_TAP_MAX_AVG_INTERVAL_MS = 240;
	const FOCUS_RAPID_TAP_ACTIVE_MS = 420;
	const FOCUS_RAPID_TAP_MIN_DISTANCE_MS = 80;
	const FOCUS_RAPID_TAP_MAX_DISTANCE_MS = 260;
	let focusEdgeSpace = 0;
	let focusWheelDelta = 0;
	let focusWheelResetTimer: ReturnType<typeof setTimeout> | null = null;
	let lastFocusedIdx = -1;

	function isTextInputTarget(target: EventTarget | null) {
		const el = target instanceof HTMLElement ? target : null;
		return !!el?.closest("input, textarea, select, [contenteditable='true']");
	}

	function isMarkdownPath(path: string): boolean {
		const lower = path.toLowerCase();
		return lower.endsWith('.md') || lower.endsWith('.markdown');
	}

	function rejectPendingMarkdownRenders(error: Error) {
		pendingMarkdownRenders.forEach(({ reject }) => reject(error));
		pendingMarkdownRenders.clear();
	}

	function getMarkdownWorker() {
		if (markdownWorkerFailed || typeof Worker === "undefined") return null;
		if (markdownWorker) return markdownWorker;

		try {
			markdownWorker = new Worker(
				new URL("../lib/render/markdown.worker.ts", import.meta.url),
				{ type: "module" },
			);
			markdownWorker.onmessage = (
				event: MessageEvent<
					| { id: number; result: RenderedMarkdownDocument }
					| { id: number; error: string }
				>,
			) => {
				const pending = pendingMarkdownRenders.get(event.data.id);
				if (!pending) return;
				pendingMarkdownRenders.delete(event.data.id);
				if ("result" in event.data) {
					pending.resolve(event.data.result);
				} else {
					pending.reject(new Error(event.data.error));
				}
			};
			markdownWorker.onerror = (event) => {
				markdownWorkerFailed = true;
				markdownWorker?.terminate();
				markdownWorker = null;
				rejectPendingMarkdownRenders(new Error(event.message || "Markdown worker failed"));
			};
		} catch (err) {
			markdownWorkerFailed = true;
			console.warn("Markdown worker unavailable.", err);
			return null;
		}

		return markdownWorker;
	}

	async function renderMarkdownForUi(source: string): Promise<RenderedMarkdownDocument> {
		const worker = getMarkdownWorker();
		if (worker) {
			try {
				const id = nextRenderRequestId++;
				return await new Promise<RenderedMarkdownDocument>((resolve, reject) => {
					pendingMarkdownRenders.set(id, { resolve, reject });
					worker.postMessage({ id, source });
				});
			} catch (err) {
				markdownWorkerFailed = true;
				markdownWorker?.terminate();
				markdownWorker = null;
				console.warn("Markdown worker render failed.", err);
			}
		}

		const { renderMarkdownDocument } = await import("$lib/render/markdown");
		return renderMarkdownDocument(source);
	}

	function getExternalUrlToOpen(rawHref: string | null): string | null {
		if (!rawHref || !/^[a-z][a-z0-9+.-]*:/i.test(rawHref)) return null;
		try {
			const url = new URL(rawHref, window.location.href);
			if (["http:", "https:", "mailto:", "tel:"].includes(url.protocol)) {
				return url.href;
			}
		} catch {
			// Ignore malformed links and let the browser keep its default behavior.
		}
		return null;
	}

	function handleArticleLinkClick(event: MouseEvent, link: HTMLAnchorElement): boolean {
		const externalUrl = getExternalUrlToOpen(link.getAttribute("href"));
		if (!externalUrl) return false;

		event.preventDefault();
		event.stopPropagation();
		void openUrl(externalUrl).catch((err) => {
			console.error("Failed to open external URL:", err);
		});
		return true;
	}

	function runWhenIdle(callback: () => void, timeout = 5000) {
		if ("requestIdleCallback" in window) {
			window.requestIdleCallback(callback, { timeout });
			return;
		}
		setTimeout(callback, 1200);
	}

	function scheduleUpdateCheck() {
		const dayMs = 24 * 60 * 60 * 1000;
		runWhenIdle(() => {
			try {
				const lastCheck = Number(localStorage.getItem("mmbook-last-update-check") || "0");
				if (Number.isFinite(lastCheck) && Date.now() - lastCheck < dayMs) return;
				localStorage.setItem("mmbook-last-update-check", String(Date.now()));
			} catch {
				// localStorage can be unavailable; still allow a best-effort check.
			}

			check().then(async (update) => {
				if (update) {
					await update.downloadAndInstall();
				}
			}).catch(() => {});
		});
	}

	function clearFocusScrollActive() {
		isFocusScrollActive = false;
		focusLockedIndex = null;
		stopFocusKeyScroll({ restoreStyles: false });
		resetFocusTapTracking();
		clearProgrammaticFocusScrollLock();
		if (focusScrollEndTimer) {
			clearTimeout(focusScrollEndTimer);
			focusScrollEndTimer = null;
		}
	}

	function markFocusScrollActive() {
		if (!isFocusScrollActive) {
			isFocusScrollActive = true;
		}
		if (focusScrollEndTimer) {
			clearTimeout(focusScrollEndTimer);
		}
		focusScrollEndTimer = setTimeout(() => {
			isFocusScrollActive = false;
			focusLockedIndex = null;
			focusScrollEndTimer = null;
		}, FOCUS_SCROLL_ACTIVE_MS);
	}

	function clearProgrammaticFocusScrollLock() {
		if (focusProgrammaticScrollTimer) {
			clearTimeout(focusProgrammaticScrollTimer);
			focusProgrammaticScrollTimer = null;
		}
		focusProgrammaticScrollIndex = null;
		focusProgrammaticScrollTarget = null;
	}

	function scheduleProgrammaticFocusScrollUnlock(delay = FOCUS_PROGRAMMATIC_SCROLL_SETTLE_MS) {
		if (focusProgrammaticScrollTimer) {
			clearTimeout(focusProgrammaticScrollTimer);
		}
		focusProgrammaticScrollTimer = setTimeout(() => {
			focusProgrammaticScrollTimer = null;
			focusProgrammaticScrollIndex = null;
			focusProgrammaticScrollTarget = null;
		}, delay);
	}

	function lockProgrammaticFocusScroll(index: number, targetScrollTop: number) {
		if (index < 0) return;
		focusProgrammaticScrollIndex = index;
		focusProgrammaticScrollTarget = targetScrollTop;
		focusLockedIndex = index;
		scheduleProgrammaticFocusScrollUnlock();
	}

	function getScheduledFocusIndex() {
		return focusProgrammaticScrollIndex ?? focusLockedIndex ?? undefined;
	}

	function getFocusKeyScrollSpeed() {
		if (!contentEl) return FOCUS_KEY_SCROLL_MIN_SPEED;
		return Math.max(
			FOCUS_KEY_SCROLL_MIN_SPEED,
			Math.min(FOCUS_KEY_SCROLL_MAX_SPEED, contentEl.clientHeight * FOCUS_KEY_SCROLL_RATIO),
		);
	}

	function setFocusImmediateScrollMode(enabled: boolean) {
		if (!contentEl) return;
		if (enabled) {
			if (focusInlineScrollBehavior === null) {
				focusInlineScrollBehavior = contentEl.style.scrollBehavior;
			}
			contentEl.style.scrollBehavior = "auto";
			return;
		}

		if (focusInlineScrollBehavior !== null) {
			contentEl.style.scrollBehavior = focusInlineScrollBehavior;
			focusInlineScrollBehavior = null;
		}
	}

	function activateFocusKeyReadableMode({ hold = false }: { hold?: boolean } = {}) {
		const wasActive = isFocusKeyScrollActive;
		if (focusKeyReadableTimer) {
			clearTimeout(focusKeyReadableTimer);
			focusKeyReadableTimer = null;
		}
		isFocusKeyScrollActive = true;
		setFocusImmediateScrollMode(true);
		if (!wasActive) {
			scheduleFocusUpdate();
		}
		if (!hold) {
			focusKeyReadableTimer = setTimeout(() => {
				focusKeyReadableTimer = null;
				deactivateFocusKeyReadableMode();
			}, FOCUS_RAPID_TAP_ACTIVE_MS);
		}
	}

	function deactivateFocusKeyReadableMode({ restoreStyles = true }: { restoreStyles?: boolean } = {}) {
		const wasActive = isFocusKeyScrollActive;
		if (focusKeyReadableTimer) {
			clearTimeout(focusKeyReadableTimer);
			focusKeyReadableTimer = null;
		}
		isFocusKeyScrollActive = false;
		setFocusImmediateScrollMode(false);
		if (wasActive && restoreStyles && $focusMode) {
			scheduleFocusUpdate();
		}
	}

	function startFocusKeyScroll(direction: -1 | 1) {
		if (!contentEl || !$focusMode) return;

		if (focusKeyScrollDirection !== direction) {
			focusKeyScrollDirection = direction;
			focusKeyScrollLastTime = 0;
		}

		clearProgrammaticFocusScrollLock();
		focusLockedIndex = null;
		markFocusScrollActive();
		activateFocusKeyReadableMode({ hold: true });

		if (focusKeyScrollFrame === null) {
			focusKeyScrollFrame = requestAnimationFrame(stepFocusKeyScroll);
		}
	}

	function stopFocusKeyScroll({ restoreStyles = true }: { restoreStyles?: boolean } = {}) {
		const wasActive = isFocusKeyScrollActive;
		if (focusKeyScrollFrame !== null) {
			cancelAnimationFrame(focusKeyScrollFrame);
			focusKeyScrollFrame = null;
		}
		focusKeyScrollDirection = 0;
		focusKeyScrollLastTime = 0;
		deactivateFocusKeyReadableMode({ restoreStyles: restoreStyles && wasActive });
	}

	function stepFocusKeyScroll(timestamp: number) {
		focusKeyScrollFrame = null;
		if (!contentEl || !$focusMode || focusKeyScrollDirection === 0) {
			stopFocusKeyScroll();
			return;
		}

		if (
			focusKeyScrollLastTime > 0 &&
			timestamp - focusKeyScrollLastTime < FOCUS_KEY_HOLD_TICK_MS
		) {
			focusKeyScrollFrame = requestAnimationFrame(stepFocusKeyScroll);
			return;
		}

		const elapsedMs = focusKeyScrollLastTime === 0
			? FOCUS_KEY_HOLD_TICK_MS
			: Math.min(timestamp - focusKeyScrollLastTime, FOCUS_KEY_SCROLL_MAX_FRAME_MS);
		focusKeyScrollLastTime = timestamp;

		const maxScrollTop = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
		const currentScrollTop = contentEl.scrollTop;
		const delta = focusKeyScrollDirection * getFocusKeyScrollSpeed() * (elapsedMs / 1000);
		const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentScrollTop + delta));

		if (Math.abs(nextScrollTop - currentScrollTop) < 0.5) {
			stopFocusKeyScroll();
			return;
		}

		contentEl.scrollTop = nextScrollTop;
		markFocusScrollActive();
		scheduleFocusUpdate();

		focusKeyScrollFrame = requestAnimationFrame(stepFocusKeyScroll);
	}

	function resetFocusTapTracking() {
		focusTapDirection = 0;
		focusTapTimes = [];
		focusRapidTapActiveUntil = 0;
	}

	function getFocusRapidTapState(direction: -1 | 1, now: number) {
		const lastTapTime = focusTapTimes[focusTapTimes.length - 1] ?? 0;
		const sameBurst =
			focusTapDirection === direction &&
			lastTapTime > 0 &&
			now - lastTapTime <= FOCUS_RAPID_TAP_RESET_MS;
		if (!sameBurst) {
			focusTapDirection = direction;
			focusTapTimes = [];
			focusRapidTapActiveUntil = 0;
		}

		const intervalMs = sameBurst ? now - lastTapTime : FOCUS_RAPID_TAP_MAX_DISTANCE_MS;
		focusTapTimes = [...focusTapTimes, now].filter(
			(time) => now - time <= FOCUS_RAPID_TAP_WINDOW_MS,
		);

		const averageIntervalMs =
			focusTapTimes.length > 1
				? (focusTapTimes[focusTapTimes.length - 1] - focusTapTimes[0]) /
					(focusTapTimes.length - 1)
				: Number.POSITIVE_INFINITY;
		const startsRapidBurst =
			focusTapTimes.length >= FOCUS_RAPID_TAP_MIN_COUNT &&
			averageIntervalMs <= FOCUS_RAPID_TAP_MAX_AVG_INTERVAL_MS;
		const continuesRapidBurst = now <= focusRapidTapActiveUntil;
		const isRapid = startsRapidBurst || continuesRapidBurst;
		if (isRapid) {
			focusRapidTapActiveUntil = now + FOCUS_RAPID_TAP_ACTIVE_MS;
		}

		return { isRapid, intervalMs };
	}

	function scrollFocusByReadableTap(direction: -1 | 1, intervalMs: number) {
		if (!contentEl) return;
		clearProgrammaticFocusScrollLock();
		focusLockedIndex = null;
		activateFocusKeyReadableMode();

		const distanceMs = Math.max(
			FOCUS_RAPID_TAP_MIN_DISTANCE_MS,
			Math.min(intervalMs, FOCUS_RAPID_TAP_MAX_DISTANCE_MS),
		);
		const maxScrollTop = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
		const currentScrollTop = contentEl.scrollTop;
		const delta = direction * getFocusKeyScrollSpeed() * (distanceMs / 1000);
		const nextScrollTop = Math.max(0, Math.min(maxScrollTop, currentScrollTop + delta));

		if (Math.abs(nextScrollTop - currentScrollTop) < 0.5) {
			deactivateFocusKeyReadableMode();
			return;
		}

		contentEl.scrollTop = nextScrollTop;
		markFocusScrollActive();
		scheduleFocusUpdate();
	}

	function scheduleFocusUpdate(preferredIdx?: number) {
		if (!$focusMode) return;
		if (preferredIdx !== undefined) {
			queuedFocusIndex = preferredIdx;
		}
		if (focusUpdateFrame !== null) return;
		focusUpdateFrame = requestAnimationFrame(() => {
			focusUpdateFrame = null;
			const nextIdx = queuedFocusIndex;
			queuedFocusIndex = undefined;
			updateFocusParagraph(nextIdx);
			updateSpotlightPosition();
		});
	}

	async function toggleFocusMode(nextState = !$focusMode) {
		if (nextState === $focusMode) return;
		if (nextState && !$currentFilePath) return;
		if (nextState) {
			$focusMode = true;
			await tick();
			enterFocusMode();
			return;
		}
		const exited = await exitFocusMode();
		if (exited) {
			$focusMode = false;
		}
	}

	onMount(() => {
		const checkInitialFile = () => {
			if ((window as any).__INITIAL_FILE__) {
				openFile((window as any).__INITIAL_FILE__);
				delete (window as any).__INITIAL_FILE__;
			}
		};
		checkInitialFile();
		setTimeout(checkInitialFile, 200);

		const handleKeydown = (e: KeyboardEvent) => {
			if (isModKey(e) && e.key === "o") {
				e.preventDefault();
				openFileDialog();
				return;
			}

			if (isModKey(e) && e.key === "f") {
				e.preventDefault();
				$searchOpen = !$searchOpen;
				if ($searchOpen) {
					tick().then(() => searchInput?.focus());
				} else {
					$searchQuery = "";
					clearSearchHighlights();
				}
				return;
			}

		if (e.key === "Escape") {
			if (editingParagraph && $focusMode) {
				// In focus mode: save the edit, then exit focus mode
				e.preventDefault();
				void finishEdit().then((saved) => {
					if (saved) void toggleFocusMode(false);
				});
				return;
			}
			if (editingParagraph) {
				cancelEdit();
			} else if ($searchOpen) {
				$searchOpen = false;
				$searchQuery = "";
				clearSearchHighlights();
			} else if ($tocOpen) {
				$tocOpen = false;
			} else if ($settingsOpen) {
				$settingsOpen = false;
			} else if ($focusMode) {
				e.preventDefault();
				void toggleFocusMode(false);
			}
			return;
		}

			if (isModKey(e) && e.key === "t") {
				e.preventDefault();
				$tocOpen = !$tocOpen;
				return;
			}

			if (e.key === "F11" || (isModKey(e) && e.shiftKey && e.key === "F")) {
				e.preventDefault();
				void toggleFocusMode(!$focusMode);
				return;
			}

			if ($focusMode && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextInputTarget(e.target)) {
				// Arrow key strategy: deliberate taps move block-by-block, rapid same-direction
				// taps scan at a readable speed, and OS key repeat scans at a fixed tick rate.
				if (e.key === "ArrowUp") {
					e.preventDefault();
					if (e.repeat) {
						resetFocusTapTracking();
						startFocusKeyScroll(-1);
					} else {
						const tapState = getFocusRapidTapState(-1, performance.now());
						if (tapState.isRapid) {
							scrollFocusByReadableTap(-1, tapState.intervalMs);
						} else {
							stopFocusKeyScroll();
							moveFocus(-1);
						}
					}
					return;
				}
				if (e.key === "ArrowDown") {
					e.preventDefault();
					if (e.repeat) {
						resetFocusTapTracking();
						startFocusKeyScroll(1);
					} else {
						const tapState = getFocusRapidTapState(1, performance.now());
						if (tapState.isRapid) {
							scrollFocusByReadableTap(1, tapState.intervalMs);
						} else {
							stopFocusKeyScroll();
							moveFocus(1);
						}
					}
					return;
				}
				if (e.key === "ArrowLeft") {
					e.preventDefault();
					moveFocus(-1);
					return;
				}
				if (e.key === "ArrowRight") {
					e.preventDefault();
					moveFocus(1);
					return;
				}
			}

			if ($searchOpen && e.key === "Enter") {
				e.preventDefault();
				if (e.shiftKey) {
					navigateSearch(-1);
				} else {
					navigateSearch(1);
				}
				return;
			}

			if (isModKey(e) && e.key === ",") {
				e.preventDefault();
				$settingsOpen = !$settingsOpen;
			}
		};

		const handleKeyup = (e: KeyboardEvent) => {
			if ((e.key === "ArrowUp" || e.key === "ArrowDown") && focusKeyScrollDirection !== 0) {
				stopFocusKeyScroll();
			}
		};

		const handleWindowBlur = () => {
			stopFocusKeyScroll();
		};

		const handleScroll = () => {
			if (!contentEl) return;
			const scrollTop = contentEl.scrollTop;
			const scrollHeight = contentEl.scrollHeight - contentEl.clientHeight;
			readingProgress = scrollHeight > 0 ? scrollTop / scrollHeight : 0;

			if ($focusMode) {
				markFocusScrollActive();
				if (focusProgrammaticScrollIndex !== null) {
					const targetReached =
						focusProgrammaticScrollTarget !== null &&
						Math.abs(scrollTop - focusProgrammaticScrollTarget) < 1;
					scheduleProgrammaticFocusScrollUnlock(
						targetReached ? FOCUS_SCROLL_ACTIVE_MS : FOCUS_PROGRAMMATIC_SCROLL_SETTLE_MS,
					);
				}
				scheduleFocusUpdate(getScheduledFocusIndex());
			}

			// Update edit orbit particle position when scrolling during edit in focus mode
			if (editingParagraph && isEditingInDarkFocus) {
				updateEditOrbitPosition();
			}

			if ($currentFilePath && !saveStateTimer) {
				saveStateTimer = setTimeout(() => {
					saveStateTimer = null;
					void saveState();
				}, 5000);
			}
		};

		const handleWheel = (e: WheelEvent) => {
			if (!contentEl || !$focusMode) return;
			const blocks = getFocusBlocks();
			if (blocks.length === 0 || Math.abs(e.deltaY) < 0.01) return;

			const direction = e.deltaY > 0 ? 1 : -1;
			if (allowNativeLongBlockWheel(blocks, direction)) {
				focusWheelDelta = 0;
				if (focusWheelResetTimer) {
					clearTimeout(focusWheelResetTimer);
					focusWheelResetTimer = null;
				}
				return;
			}

			e.preventDefault();
			focusWheelDelta += e.deltaY;

			if (focusWheelResetTimer) {
				clearTimeout(focusWheelResetTimer);
			}
			focusWheelResetTimer = setTimeout(() => {
				focusWheelDelta = 0;
				focusWheelResetTimer = null;
			}, 120);

			if (Math.abs(focusWheelDelta) < FOCUS_WHEEL_STEP) return;

			const stepDirection = focusWheelDelta > 0 ? 1 : -1;
			focusWheelDelta = 0;
			moveFocus(stepDirection);
		};

		const handleContentClick = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target || !contentEl.querySelector(".article")?.contains(target)) return;

			const link = target.closest("a[href]") as HTMLAnchorElement | null;
			if (link && handleArticleLinkClick(e, link)) {
				return;
			}

			if (!$focusMode || editingParagraph) return;
			focusBlockFromInteraction(target);
		};

		const handleDblClick = (e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote");
			if (target && contentEl.querySelector(".article")?.contains(target)) {
				startEdit(target as HTMLElement);
			}
		};

		// Tauri drag-and-drop (replaces HTML5 drag-and-drop)
		const appWindow = getCurrentWebviewWindow();
		const unlistenDrop = appWindow.onDragDropEvent((event) => {
			if (event.payload.type === 'drop') {
				const mdFile = event.payload.paths.find(
					(p: string) => isMarkdownPath(p)
				);
				if (mdFile) {
					// openFile will handle canceling any active edit
					openFile(mdFile);
				}
			}
		});

		// macOS: file opened via Apple Event (double-click / Open With)
		const unlistenOpenFile = listen<string>('open-file', (event) => {
			// openFile will handle canceling any active edit
			openFile(event.payload);
		});

		window.addEventListener("keydown", handleKeydown);
		window.addEventListener("keyup", handleKeyup);
		window.addEventListener("blur", handleWindowBlur);
		contentEl?.addEventListener("scroll", handleScroll);
		contentEl?.addEventListener("wheel", handleWheel, { passive: false });
		contentEl?.addEventListener("click", handleContentClick);
		contentEl?.addEventListener("dblclick", handleDblClick);
		const handleResize = () => {
			invalidateFocusMetrics();
			if ($focusMode) {
				rebuildFocusMetrics();
				scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
			}
			updateEditOrbitPosition();
		};
		window.addEventListener("resize", handleResize);
		const handleBeforeUnload = () => {
			if ($currentFilePath && contentEl) void flushSaveState();
		};
		window.addEventListener("beforeunload", handleBeforeUnload);

		// Intercept window close to save active edit before exit
		let isClosing = false;
		const unlistenClose = appWindow.onCloseRequested((event) => {
			if (isClosing) return;
			event.preventDefault();
			isClosing = true;
			void (async () => {
				try {
					await appWindow.hide();
					if (editingParagraph) {
						// Best effort: never block app exit on save/diff/render edge cases
						await Promise.race([
							finishEdit(),
							new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200)),
						]);
					}
					await Promise.race([
						flushSaveState(),
						new Promise<void>((resolve) => setTimeout(resolve, 500)),
					]);
				} catch (err) {
					console.error("Failed to finish edit on close:", err);
				} finally {
					// Exit from the Rust side so the process terminates even if window APIs misbehave.
					try {
						await invoke("quit_app");
					} catch (err) {
						console.error("Failed to quit via backend:", err);
						try {
							await appWindow.destroy();
						} catch (destroyErr) {
							isClosing = false;
							console.error("Failed to destroy window:", destroyErr);
						}
					}
				}
			})();
		});

		// Silent auto-update: download + install in background, applies on next launch.
		scheduleUpdateCheck();

		return () => {
			unlistenDrop.then(fn => fn());
			unlistenOpenFile.then(fn => fn());
			unlistenClose.then(fn => fn());
			window.removeEventListener("keydown", handleKeydown);
			window.removeEventListener("keyup", handleKeyup);
			window.removeEventListener("blur", handleWindowBlur);
			contentEl?.removeEventListener("scroll", handleScroll);
			contentEl?.removeEventListener("wheel", handleWheel);
			contentEl?.removeEventListener("click", handleContentClick);
			contentEl?.removeEventListener("dblclick", handleDblClick);
			window.removeEventListener("resize", handleResize);
			window.removeEventListener("beforeunload", handleBeforeUnload);
			if (focusWheelResetTimer) {
				clearTimeout(focusWheelResetTimer);
			}
			if (searchDebounceTimer) {
				clearTimeout(searchDebounceTimer);
			}
			if (saveStateTimer) {
				clearTimeout(saveStateTimer);
			}
			clearFocusScrollActive();
			if (focusUpdateFrame !== null) {
				cancelAnimationFrame(focusUpdateFrame);
				focusUpdateFrame = null;
			}
			markdownWorker?.terminate();
			markdownWorker = null;
			rejectPendingMarkdownRenders(new Error("Component destroyed"));
		};
	});

	async function openFileDialog() {
		const selected = await open({
			multiple: false,
			filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
		});
		if (selected) {
			openFile(selected as string);
		}
	}

	async function openFile(path: string) {
		// Finish any active edit before switching files (saves changes)
		if (editingParagraph) {
			const saved = await finishEdit();
			if (!saved) return;
		}

		if ($currentFilePath) {
			await flushSaveState();
		}

		// Race condition protection: invalidate previous loads
		const loadToken = path + ':' + Date.now();
		currentLoadToken = loadToken;

		$isLoading = true;
		fileError = "";
		const nextFileName = path.split(/[\\/]/).pop() || "";
		let loadSucceeded = false;

		try {
			const result = await invoke<{content: string, encoding: string}>("read_markdown_file", {
				path,
			});
			if (currentLoadToken !== loadToken) return;

			const rendered = await renderMarkdownForUi(result.content);
			if (currentLoadToken !== loadToken) return;

			$currentFilePath = path;
			fileName = nextFileName;
			$markdownSource = result.content;
			fileEncoding = result.encoding;
			$renderedHtml = rendered.html;
			tocItems = rendered.toc;

			// Reset focus state when file changes
			stopFocusKeyScroll({ restoreStyles: false });
			resetFocusTapTracking();
			lastFocusedIdx = -1;
			focusLockedIndex = null;
			spotlightHeight = 100;
			focusEdgeSpace = 0;
			focusBlocks = [];
			focusStyleCache = new WeakMap<HTMLElement, string>();
			lastFocusStyleIndices = new Set<number>();
			lastFocusStyleTheme = "";
			lastFocusSearchIndex = -1;
			lastFocusStyleKeyScrollActive = false;
			lastFocusRenderSignature = "";
			lastSpotlightVars = new Map<string, string>();
			clearProgrammaticFocusScrollLock();
			invalidateFocusMetrics();

			await tick();

			try {
				const state: { scroll_position: number; bookmarks: number[] } =
					await invoke("load_reading_state", { path });
				if (currentLoadToken !== loadToken) return;
				if (state.scroll_position > 0 && contentEl) {
					contentEl.scrollTop = state.scroll_position;
				}
			} catch {
				// No saved state, start from top
			}

			loadSucceeded = true;

		} catch (err) {
			if (currentLoadToken !== loadToken) return;
			console.error("Failed to open file:", err);
			fileError = `无法打开文件：${err instanceof Error ? err.message : String(err)}`;
		} finally {
			if (currentLoadToken === loadToken) {
				$isLoading = false;
			}
			if (loadSucceeded && currentLoadToken === loadToken) {
				await tick();
				if (currentLoadToken !== loadToken) return;
				if ($searchQuery.trim()) {
					performSearch();
				} else if (!$focusMode) {
					clearFocusBlockIndex();
				}
				if ($focusMode) {
					await tick();
					if (currentLoadToken !== loadToken) return;
					enterFocusMode();
				}
			}
		}
	}

	function startEdit(el: HTMLElement) {
		// Ignore new edit attempts while already editing to prevent accidental data loss
		if (editingParagraph) return;
		if (!$currentFilePath) return;
		// Refuse editing blocks with inline markup or nested block structure.
		// Heuristic diff cannot safely map rendered HTML back to markdown
		// for links, emphasis, inline code, nested lists, multi-paragraph quotes, etc.
		// Note: descendant <p> is intentionally NOT blocked — simple paragraphs
		// inside blockquotes are acceptable single-paragraph blocks.
		if (el.querySelector('a, code:not(.shiki code), strong, em, img, sup, sub, del, s, mark, ins, kbd, input[type="checkbox"], ul, ol, blockquote, pre, table')) {
			return;
		}
		editingParagraph = el;
		originalText = el.innerHTML;
		originalTextContent = el.innerText || '';
		el.setAttribute("contenteditable", "true");
		el.classList.add("editing");
		el.focus();

		el.addEventListener("blur", finishEdit, { once: true });
		el.addEventListener("keydown", handleEditKeydown);
		el.addEventListener("input", updateEditOrbitPosition);

		if ($focusMode) {
			focusBlockFromInteraction(el);
		}

		const isDark = !$currentTheme.name.includes('light');
		if ($focusMode && isDark) {
			updateEditOrbitPosition();
		}
	}

	function updateEditOrbitPosition() {
		if (!editingParagraph) return;
		const el = editingParagraph;
		const isDark = !$currentTheme.name.includes('light');
		if (!$focusMode || !isDark) return;
		const rect = el.getBoundingClientRect();
		const pad = 8;
		editOrbitContainerStyle = `left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px`;
		if (editOrbitParticles.length === 0) {
			editOrbitParticles = Array.from({length: EDIT_ORBIT_COUNT}).map((_, i) => ({
				id: i,
				size: Math.random() * 2 + 1,
				duration: 8 + Math.random() * 4,
				opacity: Math.random() * 0.5 + 0.5,
				stagger: i * 0.025,
			}));
		}
		isEditingInDarkFocus = true;
	}

	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			if ($focusMode) {
				// In focus mode: let the window-level Escape handler save and exit
				return;
			}
			e.preventDefault();
			cancelEdit();
		} else if (e.key === "Enter") {
			// Shift/Ctrl/Meta+Enter inserts a line break (browser default)
			if (e.shiftKey || e.ctrlKey || e.metaKey) return;
			e.preventDefault();
			finishEdit();
		}
	}

	function cleanupEditOrbit() {
		isEditingInDarkFocus = false;
		editOrbitParticles = [];
	}

	function teardownEdit(el: HTMLElement) {
		editingParagraph = null;
		el.removeEventListener("blur", finishEdit);
		el.removeEventListener("keydown", handleEditKeydown);
		el.removeEventListener("input", updateEditOrbitPosition);
		el.removeAttribute("contenteditable");
		el.classList.remove("editing");
		cleanupEditOrbit();
	}

	function cancelEdit() {
		if (!editingParagraph) return;
		const el = editingParagraph;
		teardownEdit(el);
		el.innerHTML = originalText;
	}

	function applyTextDiff(oldText: string, newText: string, source: string): string | null {
		if (oldText === newText) return null;

		let pre = 0;
		while (pre < oldText.length && pre < newText.length && oldText[pre] === newText[pre]) pre++;

		let suf = 0;
		while (
			suf < oldText.length - pre &&
			suf < newText.length - pre &&
			oldText[oldText.length - 1 - suf] === newText[newText.length - 1 - suf]
		) suf++;

		const oldPart = oldText.slice(pre, oldText.length - suf);
		const newPart = newText.slice(pre, newText.length - suf);

		// Use surrounding context to avoid false matches in source
		const ctxBefore = oldText.slice(Math.max(0, pre - 15), pre);
		const ctxAfter = oldText.slice(oldText.length - suf, Math.min(oldText.length, oldText.length - suf + 15));
		const searchStr = ctxBefore + oldPart + ctxAfter;
		const replaceStr = ctxBefore + newPart + ctxAfter;

		let idx = source.indexOf(searchStr);
		if (idx !== -1) {
			return source.slice(0, idx) + replaceStr + source.slice(idx + searchStr.length);
		}

		// Fallback: match without context (for short blocks)
		if (oldPart) {
			idx = source.indexOf(oldPart);
			if (idx !== -1) {
				return source.slice(0, idx) + newPart + source.slice(idx + oldPart.length);
			}
		}

		// Fallback for pure insertions in formatted text:
		// find the insertion point using ctxAfter in source
		if (!oldPart && newPart) {
			if (ctxAfter) {
				idx = source.indexOf(ctxAfter);
				if (idx !== -1) {
					return source.slice(0, idx) + newPart + source.slice(idx);
				}
			}
			// Append at end if no ctxAfter
			return source + newPart;
		}

		// Cannot apply diff safely — do not save
		return null;
	}

	async function finishEdit(): Promise<boolean> {
		if (!editingParagraph) return true;
		if (finishEditPromise) return finishEditPromise;

		finishEditPromise = (async (): Promise<boolean> => {
			const el = editingParagraph;
			const newTextContent = el.innerText || '';

			// Capture path/encoding and original source before any mutation
			const savePath = $currentFilePath;
			const saveEncoding = fileEncoding;
			const oldText = originalText;
			const oldTextContent = originalTextContent;
			const oldMarkdownSource = $markdownSource;

			if (newTextContent === oldTextContent) {
				// No changes — just clean up
				teardownEdit(el);
				return true;
			}

			if (!savePath) {
				teardownEdit(el);
				el.innerHTML = oldText;
				return false;
			}

			const sourceStart = parseInt(el.dataset.sourceStart || '-1');
			const sourceEnd = parseInt(el.dataset.sourceEnd || '-1');
			if (sourceStart < 1 || sourceEnd < 1) {
				teardownEdit(el);
				el.innerHTML = oldText;
				return false;
			}

			const lines = oldMarkdownSource.split('\n');
			const sourceBlock = lines.slice(sourceStart - 1, sourceEnd).join('\n');
			const patched = applyTextDiff(oldTextContent, newTextContent, sourceBlock);
			if (patched === null) {
				teardownEdit(el);
				el.innerHTML = oldText;
				return false;
			}

			// Convert single line breaks into GFM hard breaks to preserve rendered wrapping
			const patchedWithHardBreaks = patched.replace(/(?<!  )\n/g, '  \n');
			const patchedLines = patchedWithHardBreaks.split('\n');
			const originalLineCount = sourceEnd - sourceStart + 1;
			lines.splice(sourceStart - 1, sourceEnd - sourceStart + 1, ...patchedLines);
			$markdownSource = lines.join('\n');

			try {
				await invoke('save_markdown_file', { path: savePath, content: $markdownSource, encoding: saveEncoding });
				fileError = "";
			} catch (err) {
				console.error('Failed to save:', err);
				fileError = `保存失败：${err instanceof Error ? err.message : String(err)}`;
				$markdownSource = oldMarkdownSource;
				teardownEdit(el);
				el.innerHTML = oldText;
				return false;
			}

			// Success — now tear down edit state
			teardownEdit(el);

			const requiresFullRerender =
				/^H[1-6]$/.test(el.tagName) ||
				patchedLines.length !== originalLineCount;
			if (!requiresFullRerender) {
				invalidateFocusMetrics();
				if ($searchQuery.trim()) {
					performSearch();
				} else if ($focusMode) {
					refreshFocusBlocks();
					scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
				} else {
					clearFocusBlockIndex();
				}
				await saveState();
				return true;
			}

			// Re-render to keep data-source-* attributes in sync
			const scrollPos = contentEl?.scrollTop ?? 0;
			const rendered = await renderMarkdownForUi($markdownSource);
			$renderedHtml = rendered.html;
			tocItems = rendered.toc;
			await tick();
			if (contentEl) contentEl.scrollTop = scrollPos;
			focusStyleCache = new WeakMap<HTMLElement, string>();
			lastFocusStyleIndices = new Set<number>();
			lastFocusStyleTheme = "";
			lastFocusSearchIndex = -1;
			lastFocusRenderSignature = "";

			// Refresh focus blocks after re-render so focus mode stays in sync
			if ($searchQuery.trim()) {
				// Rebuild search highlights if search is active, since DOM was replaced
				performSearch();
			} else if ($focusMode) {
				refreshFocusBlocks();
				scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
			} else {
				clearFocusBlockIndex();
			}

			await saveState();
			return true;
		})();

		try {
			return await finishEditPromise;
		} finally {
			finishEditPromise = null;
		}
	}

	async function saveState() {
		if (!$currentFilePath || !contentEl) return;
		try {
			await invoke("save_reading_state", {
				path: $currentFilePath,
				state: {
					scroll_position: contentEl.scrollTop,
					bookmarks: [],
				},
			});
		} catch (e) {
			console.error("Failed to save state:", e);
		}
	}

	async function flushSaveState() {
		if (saveStateTimer) {
			clearTimeout(saveStateTimer);
			saveStateTimer = null;
		}
		await saveState();
	}

	function getArticleElement() {
		return contentEl?.querySelector(".article") as HTMLElement | null;
	}

	function collectFocusBlocks(article: HTMLElement) {
		const blocks: HTMLElement[] = [];
		for (const child of Array.from(article.children)) {
			if (!(child instanceof HTMLElement) || child.offsetHeight <= 0) {
				continue;
			}

			if (child.tagName === "TABLE") {
				const rows = Array.from(
					child.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr"),
				).filter(
					(row): row is HTMLElement =>
						row instanceof HTMLElement && row.offsetHeight > 0,
				);
				if (rows.length > 0) {
					blocks.push(...rows);
					continue;
				}
			}

			if (child.tagName === "UL" || child.tagName === "OL") {
				const items = Array.from(child.children).filter(
					(item): item is HTMLElement =>
						item instanceof HTMLElement && item.tagName === "LI" && item.offsetHeight > 0,
				);
				if (items.length > 0) {
					blocks.push(...items);
					continue;
				}
			}

			blocks.push(child);
		}
		return blocks;
	}

	function invalidateFocusMetrics() {
		focusMetricsValid = false;
		focusBlockMetrics = [];
	}

	function rebuildFocusMetrics(blocks = focusBlocks) {
		if (!contentEl || blocks.length === 0) {
			focusBlockMetrics = [];
			focusMetricsValid = true;
			return focusBlockMetrics;
		}

		const contentRect = contentEl.getBoundingClientRect();
		const scrollTop = contentEl.scrollTop;
		focusBlockMetrics = blocks.map((block) => {
			const rect = block.getBoundingClientRect();
			const top = scrollTop + rect.top - contentRect.top;
			const bottom = top + rect.height;
			return {
				top,
				bottom,
				center: (top + bottom) / 2,
			};
		});
		focusMetricsValid = true;
		return focusBlockMetrics;
	}

	function getFocusMetrics(blocks = focusBlocks) {
		return focusMetricsValid && focusBlockMetrics.length === blocks.length
			? focusBlockMetrics
			: rebuildFocusMetrics(blocks);
	}

	function refreshFocusBlocks() {
		const article = getArticleElement();
		if (!article) {
			focusBlocks = [];
			invalidateFocusMetrics();
			return focusBlocks;
		}

		article.querySelectorAll("[data-focus-block='true']").forEach((node) => {
			node.removeAttribute("data-focus-block");
			node.removeAttribute("data-focus-index");
		});

		focusBlocks = collectFocusBlocks(article);
		focusBlocks.forEach((block, index) => {
			block.dataset.focusBlock = "true";
			block.dataset.focusIndex = `${index}`;
		});
		rebuildFocusMetrics(focusBlocks);
		return focusBlocks;
	}

	function clearFocusBlockIndex() {
		focusBlocks = [];
		invalidateFocusMetrics();
	}

	function getFocusBlocks() {
		return focusBlocks.length > 0 ? focusBlocks : refreshFocusBlocks();
	}

	function getFocusStyleTargets(block: HTMLElement) {
		if (block.tagName === "TR") {
			const cells = Array.from(block.children).filter(
				(cell): cell is HTMLElement => cell instanceof HTMLElement,
			);
			return cells.length > 0 ? cells : [block];
		}
		return [block];
	}

	function clearBlockFocusStyle(block: HTMLElement) {
		for (const target of getFocusStyleTargets(block)) {
			target.style.filter = "";
			target.style.opacity = "";
			target.style.transform = "";
			target.style.textShadow = "";
			target.style.color = "";
			focusStyleCache.delete(target);
		}
	}

	function getBlockForNode(node: Node | null) {
		const element = node instanceof Element ? node : node?.parentElement ?? null;
		return element?.closest("[data-focus-block='true']") as HTMLElement | null;
	}

	function getFocusIndexForBlock(block: HTMLElement | null) {
		const index = Number(block?.dataset.focusIndex ?? "-1");
		return Number.isFinite(index) && index >= 0 ? index : -1;
	}

	function getSearchPreferredFocusIndex() {
		const block = currentMatchIndex >= 0 ? searchMatches[currentMatchIndex]?.block ?? null : null;
		const index = getFocusIndexForBlock(block);
		return index >= 0 ? index : undefined;
	}

	function focusBlockFromInteraction(node: Node | null): boolean {
		if (!$focusMode || !contentEl) return false;
		const block = getBlockForNode(node);
		if (!block) return false;
		const index = getFocusIndexForBlock(block);
		if (index < 0) return false;

		focusLockedIndex = index;
		markFocusScrollActive();
		updateFocusParagraph(index);
		scrollBlockToFocusPosition(block, index);

		requestAnimationFrame(() => {
			updateSpotlightPosition();
			if (editingParagraph && isEditingInDarkFocus) {
				updateEditOrbitPosition();
			}
		});
		return true;
	}

	function getFocusAnchorY() {
		if (typeof window === "undefined") return 0;
		return window.innerHeight * FOCUS_ANCHOR_RATIO;
	}

	function getFocusAnchorOffset() {
		if (!contentEl) return 0;
		return getFocusAnchorY() - contentEl.getBoundingClientRect().top;
	}

	function getFocusEdgeSpacing() {
		if (!contentEl) return 0;
		return Math.max(
			Math.round(contentEl.clientHeight * FOCUS_EDGE_SPACE_RATIO),
			FOCUS_EDGE_SPACE_MIN,
		);
	}

	function getClosestFocusIndex(blocks: HTMLElement[]) {
		if (!contentEl || blocks.length === 0) return 0;
		const metrics = getFocusMetrics(blocks);
		const anchorY = contentEl.scrollTop + getFocusAnchorOffset();

		let low = 0;
		let high = metrics.length - 1;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			const metric = metrics[mid];
			if (anchorY < metric.top) {
				high = mid - 1;
			} else if (anchorY > metric.bottom) {
				low = mid + 1;
			} else {
				return mid;
			}
		}

		const before = clampFocusIndex(high, metrics.length);
		const after = clampFocusIndex(low, metrics.length);
		const beforeDistance = Math.abs(metrics[before].center - anchorY);
		const afterDistance = Math.abs(metrics[after].center - anchorY);
		return beforeDistance <= afterDistance ? before : after;
	}

	function clampFocusIndex(index: number, length: number) {
		return Math.max(0, Math.min(index, length - 1));
	}

	function getLongFocusBlockEdgeBuffer() {
		if (!contentEl) return FOCUS_LONG_BLOCK_EDGE_MIN;
		return Math.max(
			FOCUS_LONG_BLOCK_EDGE_MIN,
			Math.min(
				FOCUS_LONG_BLOCK_EDGE_MAX,
				Math.round(contentEl.clientHeight * FOCUS_LONG_BLOCK_EDGE_RATIO),
			),
		);
	}

	function getCurrentFocusIndexForWheel(blocks: HTMLElement[]) {
		const lockedIndex = focusProgrammaticScrollIndex ?? focusLockedIndex;
		if (lockedIndex !== null) {
			return clampFocusIndex(lockedIndex, blocks.length);
		}
		return lastFocusedIdx >= 0
			? clampFocusIndex(lastFocusedIdx, blocks.length)
			: getClosestFocusIndex(blocks);
	}

	function allowNativeLongBlockWheel(blocks: HTMLElement[], direction: number) {
		if (!contentEl || blocks.length === 0) return false;
		const currentIdx = getCurrentFocusIndexForWheel(blocks);
		const metric = getFocusMetrics(blocks)[currentIdx];
		const block = blocks[currentIdx];
		if (!metric || !block) return false;

		const blockHeight = metric.bottom - metric.top;
		if (blockHeight <= contentEl.clientHeight * FOCUS_LONG_BLOCK_RATIO) return false;

		const anchorY = contentEl.scrollTop + getFocusAnchorOffset();
		const edgeBuffer = getLongFocusBlockEdgeBuffer();
		const canScrollInsideBlock =
			direction > 0
				? anchorY < metric.bottom - edgeBuffer
				: anchorY > metric.top + edgeBuffer;

		if (!canScrollInsideBlock) return false;

		clearProgrammaticFocusScrollLock();
		focusLockedIndex = currentIdx;
		markFocusScrollActive();
		scheduleFocusUpdate(currentIdx);
		return true;
	}

	function applyFocusSpacing({ preservePosition }: { preservePosition: boolean }) {
		if (!contentEl) return;
		const article = getArticleElement();
		if (!article) return;

		const nextFocusEdgeSpace = getFocusEdgeSpacing();
		const spacingDelta = nextFocusEdgeSpace - focusEdgeSpace;
		article.style.paddingTop = `calc(var(--article-padding-top) + ${nextFocusEdgeSpace}px)`;
		article.style.paddingBottom = `calc(var(--article-padding-bottom) + ${nextFocusEdgeSpace}px)`;

		if (preservePosition && spacingDelta !== 0) {
			contentEl.scrollTop = Math.max(0, contentEl.scrollTop + spacingDelta);
		}

		focusEdgeSpace = nextFocusEdgeSpace;
		rebuildFocusMetrics();
	}

	function scrollBlockToFocusPosition(block: HTMLElement, focusIndex = getFocusIndexForBlock(block)) {
		if (!contentEl) return;
		const contentRect = contentEl.getBoundingClientRect();
		const blockRect = block.getBoundingClientRect();
		const blockTop = contentEl.scrollTop + blockRect.top - contentRect.top;
		const blockBottom = blockTop + blockRect.height;
		const anchorOffset = getFocusAnchorOffset();
		const anchorScrollTop = contentEl.scrollTop + anchorOffset;
		let targetScrollTop: number;

		if (blockRect.height > contentEl.clientHeight * FOCUS_LONG_BLOCK_RATIO) {
			if (anchorScrollTop >= blockTop && anchorScrollTop <= blockBottom) return;
			targetScrollTop =
				blockTop > anchorScrollTop
					? blockTop - anchorOffset
					: blockBottom - anchorOffset;
		} else {
			targetScrollTop = blockTop + blockRect.height / 2 - anchorOffset;
		}

		const maxScrollTop = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
		const nextScrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
		lockProgrammaticFocusScroll(focusIndex, nextScrollTop);
		contentEl.scrollTo({ top: nextScrollTop, behavior: "smooth" });
	}

	function applyStylesToBlock(
		block: HTMLElement,
		styles: {
			filter: string;
			opacity: string;
			transform: string;
			textShadow: string;
			color: string;
		},
	) {
		const allowScale = block.tagName !== "TR";
		const transform = allowScale ? styles.transform : "";
		const signature = [
			styles.filter,
			styles.opacity,
			transform,
			styles.textShadow,
			styles.color,
		].join("|");
		for (const target of getFocusStyleTargets(block)) {
			if (focusStyleCache.get(target) === signature) continue;
			target.style.filter = styles.filter;
			target.style.opacity = styles.opacity;
			target.style.transform = transform;
			target.style.textShadow = styles.textShadow;
			target.style.color = styles.color;
			focusStyleCache.set(target, signature);
		}
	}

	const FOCUS_STYLE_RADIUS = 6;

	function getFocusStyleIndices(blocks: HTMLElement[], hitIdx: number, currentSearchIndex: number) {
		const indices = new Set<number>();
		const start = Math.max(0, hitIdx - FOCUS_STYLE_RADIUS);
		const end = Math.min(blocks.length - 1, hitIdx + FOCUS_STYLE_RADIUS);
		for (let i = start; i <= end; i++) {
			indices.add(i);
		}
		if (currentSearchIndex >= 0) {
			indices.add(currentSearchIndex);
		}
		return indices;
	}

	function applyFocusStyles(blocks: HTMLElement[], hitIdx: number) {
		const currentSearchBlock = currentMatchIndex >= 0
			? searchMatches[currentMatchIndex]?.block ?? null
			: null;
		const signature = `${hitIdx}|${currentMatchIndex}|${searchMatchBlocks.size}|${$currentTheme.name}|${isFocusKeyScrollActive}`;
		if (signature === lastFocusRenderSignature) {
			lastFocusedIdx = hitIdx;
			return;
		}
		const previousFocusedIdx = lastFocusedIdx;
		lastFocusRenderSignature = signature;

		const glowColor = getComputedStyle(document.documentElement)
			.getPropertyValue("--focus-text-glow")
			.trim();
		const hasGlow = glowColor && !glowColor.includes("0, 0, 0, 0") && glowColor !== "transparent";

		const currentSearchIndex = getFocusIndexForBlock(currentSearchBlock);
		const nextStyleIndices = getFocusStyleIndices(blocks, hitIdx, currentSearchIndex);
		const forceFullStylePass =
			lastFocusStyleIndices.size === 0 ||
			lastFocusStyleTheme !== $currentTheme.name ||
			lastFocusStyleKeyScrollActive !== isFocusKeyScrollActive ||
			previousFocusedIdx < 0;
		const indicesToUpdate = forceFullStylePass
			? blocks.map((_, index) => index)
			: [
					...new Set([
						...lastFocusStyleIndices,
						...nextStyleIndices,
						lastFocusSearchIndex,
					]),
				].filter((index) => index >= 0);

		for (const i of indicesToUpdate) {
			const block = blocks[i];
			if (!block) continue;
			const dist = Math.abs(i - hitIdx);
			const isCurrentFocus = i === hitIdx;
			const textColor = /^H[1-6]$/.test(block.tagName) ? "var(--heading)" : "";
			const glow = hasGlow && (isCurrentFocus || block === currentSearchBlock)
				? `0 0 8px ${glowColor}, 0 0 20px ${glowColor}`
				: "none";

			if (isCurrentFocus) {
				applyStylesToBlock(block, {
					filter: "none",
					opacity: "1",
					transform: "none",
					textShadow: glow,
					color: textColor,
				});
				continue;
			}

			if (isFocusKeyScrollActive) {
				const blur = dist === 1
					? 0.3
					: dist === 2
						? 0.6
						: dist === 3
							? 0.9
							: Math.min(1.2 + (dist - 3) * 0.25, 2.8);
				const opacity = dist === 1
					? 0.86
					: dist === 2
						? 0.74
						: dist === 3
							? 0.62
							: Math.max(0.32, 0.54 - (dist - 3) * 0.035);
				applyStylesToBlock(block, {
					filter: `blur(${blur}px)`,
					opacity: `${opacity}`,
					transform: "none",
					textShadow: "none",
					color: "",
				});
			} else if (dist === 1) {
				applyStylesToBlock(block, {
					filter: "blur(2.5px)",
					opacity: "0.2",
					transform: "scale(0.995)",
					textShadow: "none",
					color: "",
				});
			} else if (dist === 2) {
				applyStylesToBlock(block, {
					filter: "blur(5px)",
					opacity: "0.08",
					transform: "scale(0.99)",
					textShadow: "none",
					color: "",
				});
			} else if (dist === 3) {
				applyStylesToBlock(block, {
					filter: "blur(8px)",
					opacity: "0.04",
					transform: "scale(0.985)",
					textShadow: "none",
					color: "",
				});
			} else {
				const blur = Math.min(8 + (dist - 3) * 2, 16);
				const opacity = Math.max(0.01, 0.03 - (dist - 3) * 0.005);
				applyStylesToBlock(block, {
					filter: `blur(${blur}px)`,
					opacity: `${opacity}`,
					transform: "scale(0.98)",
					textShadow: "none",
					color: "",
				});
			}
		}

		lastFocusStyleIndices = nextStyleIndices;
		lastFocusStyleTheme = $currentTheme.name;
		lastFocusSearchIndex = currentSearchIndex;
		lastFocusStyleKeyScrollActive = isFocusKeyScrollActive;
		lastFocusedIdx = hitIdx;
	}

	function updateFocusParagraph(preferredIdx?: number) {
		if (!contentEl) return;
		const blocks = getFocusBlocks();
		if (blocks.length === 0) return;

		const preferredSearchIdx = preferredIdx ?? getSearchPreferredFocusIndex();
		const hitIdx = preferredSearchIdx === undefined
			? getClosestFocusIndex(blocks)
			: clampFocusIndex(preferredSearchIdx, blocks.length);

		applyFocusStyles(blocks, hitIdx);
	}

	function moveFocus(direction: number) {
		const blocks = getFocusBlocks();
		if (blocks.length === 0) return;

		const baseIdx = lastFocusedIdx >= 0 ? lastFocusedIdx : getClosestFocusIndex(blocks);
		const nextIdx = clampFocusIndex(baseIdx + direction, blocks.length);
		focusLockedIndex = nextIdx;
		markFocusScrollActive();
		updateFocusParagraph(nextIdx);
		scrollBlockToFocusPosition(blocks[nextIdx], nextIdx);
		updateSpotlightPosition();
	}

	function clearFocusStyles() {
		for (const block of getFocusBlocks()) {
			clearBlockFocusStyle(block);
		}
		focusStyleCache = new WeakMap<HTMLElement, string>();
		lastFocusStyleIndices = new Set<number>();
		lastFocusStyleTheme = "";
		lastFocusSearchIndex = -1;
		lastFocusStyleKeyScrollActive = false;
		lastFocusedIdx = -1;
		lastFocusRenderSignature = "";
		lastSpotlightVars = new Map<string, string>();
	}

	function setRootStylePropertyIfChanged(style: CSSStyleDeclaration, name: string, value: string) {
		if (lastSpotlightVars.get(name) === value) return;
		style.setProperty(name, value);
		lastSpotlightVars.set(name, value);
	}

	function updateSpotlightPosition() {
		if (!contentEl) return;
		const blocks = getFocusBlocks();
		if (lastFocusedIdx < 0 || lastFocusedIdx >= blocks.length) return;

		const activeBlock = blocks[lastFocusedIdx];
		const rect = activeBlock.getBoundingClientRect();
		const anchorY = getFocusAnchorY();
		const maxSpotlightHeight = Math.max(
			FOCUS_SPOTLIGHT_MIN,
			Math.round(contentEl.clientHeight * FOCUS_SPOTLIGHT_MAX_RATIO),
		);
		const targetSpotlightHeight = Math.min(
			Math.max(rect.height, FOCUS_SPOTLIGHT_MIN),
			maxSpotlightHeight,
		);
		spotlightHeight += (targetSpotlightHeight - spotlightHeight) * 0.24;
		if (Math.abs(targetSpotlightHeight - spotlightHeight) < 0.5) {
			spotlightHeight = targetSpotlightHeight;
		}
		const docStyle = document.documentElement.style;
		setRootStylePropertyIfChanged(docStyle, "--spotlight-top", `${anchorY - spotlightHeight / 2}px`);
		setRootStylePropertyIfChanged(docStyle, "--spotlight-height", `${spotlightHeight}px`);
		setRootStylePropertyIfChanged(docStyle, "--spotlight-left", `${rect.left}px`);
		setRootStylePropertyIfChanged(docStyle, "--spotlight-right", `${rect.right}px`);
		setRootStylePropertyIfChanged(docStyle, "--anchor-y", `${anchorY}px`);
	}

	function enterFocusMode() {
		refreshFocusBlocks();
		const preservePosition = (contentEl?.scrollTop ?? 0) > 0;
		applyFocusSpacing({ preservePosition });
		focusWheelDelta = 0;
		lastFocusedIdx = -1;
		lastFocusRenderSignature = "";
		lastFocusStyleIndices = new Set<number>();
		lastFocusStyleTheme = "";
		lastFocusSearchIndex = -1;
		lastFocusStyleKeyScrollActive = false;
		spotlightHeight = 100;
		lastSpotlightVars = new Map<string, string>();

		const preferredIdx = getSearchPreferredFocusIndex();
		updateFocusParagraph(preferredIdx);
		const blocks = getFocusBlocks();
		if (blocks.length === 0 || lastFocusedIdx < 0) return;

		focusLockedIndex = lastFocusedIdx;
		markFocusScrollActive();
		scrollBlockToFocusPosition(blocks[lastFocusedIdx], lastFocusedIdx);
		updateFocusParagraph(lastFocusedIdx);
		updateSpotlightPosition();
	}

	async function exitFocusMode(): Promise<boolean> {
		// Finish any active edit before exiting focus mode (awaits save + re-render)
		if (editingParagraph) {
			const saved = await finishEdit();
			if (!saved) return false; // Block focus mode exit if save failed
		}
		clearFocusStyles();
		clearFocusScrollActive();
		if (focusUpdateFrame !== null) {
			cancelAnimationFrame(focusUpdateFrame);
			focusUpdateFrame = null;
		}
		queuedFocusIndex = undefined;
		const article = getArticleElement();
		if (article) {
			const previousFocusEdgeSpace = focusEdgeSpace;
			article.style.paddingTop = "";
			article.style.paddingBottom = "";
			if (contentEl && previousFocusEdgeSpace > 0) {
				contentEl.scrollTop = Math.max(0, contentEl.scrollTop - previousFocusEdgeSpace);
			}
		}
		if (focusWheelResetTimer) {
			clearTimeout(focusWheelResetTimer);
			focusWheelResetTimer = null;
		}
		focusWheelDelta = 0;
		focusEdgeSpace = 0;
		spotlightHeight = 100;
		focusLockedIndex = null;
		resetFocusTapTracking();
		clearProgrammaticFocusScrollLock();
		lastSpotlightVars = new Map<string, string>();
		lastFocusSearchIndex = -1;
		return true;
	}

	function clearSearchHighlights() {
		if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
		clearCurrentSearchMark();

		searchMatchBlocks.forEach((block) => block.classList.remove("search-result-block"));
		searchMatchBlocks = new Set<HTMLElement>();
		searchMatches = [];
		currentMatchIndex = -1;
		lastFocusRenderSignature = "";
		if ($focusMode) {
			scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
		}
	}

	function clearCurrentSearchMark() {
		const mark = currentSearchMark;
		currentSearchMark = null;
		if (!mark) return;
		const parent = mark.parentNode;
		if (parent) {
			parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
			parent.normalize();
			invalidateFocusMetrics();
		}
	}

	function collectMatchesInBlock(block: HTMLElement, query: string, blockMatches: SearchMatch[]) {
		const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, {
			acceptNode(node) {
				const parent = node.parentElement;
				if (!parent || parent.closest("script, style")) return NodeFilter.FILTER_REJECT;
				return NodeFilter.FILTER_ACCEPT;
			}
		});
		let occurrence = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const text = node.textContent?.toLowerCase() || "";
			let idx = text.indexOf(query);
			while (idx !== -1) {
				blockMatches.push({ block, occurrence });
				occurrence += 1;
				idx = text.indexOf(query, idx + query.length);
			}
		}
		if (occurrence > 0) {
			searchMatchBlocks.add(block);
			block.classList.add("search-result-block");
		}
	}

	function materializeSearchMark(match: SearchMatch, query: string) {
		const walker = document.createTreeWalker(match.block, NodeFilter.SHOW_TEXT);
		let occurrence = 0;
		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const text = node.textContent?.toLowerCase() || "";
			let idx = text.indexOf(query);
			while (idx !== -1) {
				if (occurrence === match.occurrence) {
					const range = document.createRange();
					range.setStart(node, idx);
					range.setEnd(node, idx + query.length);
					const mark = document.createElement("mark");
					mark.className = "search-match search-current";
					range.surroundContents(mark);
					currentSearchMark = mark;
					return mark;
				}
				occurrence += 1;
				idx = text.indexOf(query, idx + query.length);
			}
		}
		return null;
	}

	function performSearch() {
		clearSearchHighlights();
		const query = $searchQuery.trim().toLowerCase();
		if (!query || !contentEl) return;

		refreshFocusBlocks();
		const article = contentEl.querySelector(".article");
		if (!article) return;

		searchMatches = [];
		const blocks = getFocusBlocks();
		for (const block of blocks) {
			collectMatchesInBlock(block, query, searchMatches);
		}

		lastFocusRenderSignature = "";
		if (searchMatches.length > 0) {
			currentMatchIndex = 0;
			highlightCurrentMatch();
		} else if ($focusMode) {
			scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
		}
	}

	function navigateSearch(direction: number) {
		if (searchMatches.length === 0) return;
		clearCurrentSearchMark();
		currentMatchIndex =
			(currentMatchIndex + direction + searchMatches.length) %
			searchMatches.length;
		highlightCurrentMatch();
	}

	function highlightCurrentMatch() {
		const match = searchMatches[currentMatchIndex];
		if (!match) return;

		clearCurrentSearchMark();
		const mark = materializeSearchMark(match, $searchQuery.trim().toLowerCase());
		if (!mark) return;
		invalidateFocusMetrics();
		if ($focusMode) {
			if (focusBlockFromInteraction(match.block)) {
				return;
			}
		}

		mark.scrollIntoView({ behavior: "smooth", block: "center" });
	}

	function scrollToHeading(id: string) {
		if (!contentEl) return;
		const el = contentEl.querySelector(`#${CSS.escape(id)}`);
		if (el) {
			el.scrollIntoView({ behavior: "smooth", block: "start" });
			$tocOpen = false;
		}
	}

	function scheduleSearch() {
		if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
		searchDebounceTimer = setTimeout(() => performSearch(), 180);
	}

	let themePairs = getThemePairs();
</script>

<div
	class="app"
	class:focus-mode={$focusMode}
	class:focus-scroll-active={isFocusScrollActive}
	class:focus-key-scroll-active={isFocusKeyScrollActive}
	class:is-light-theme={isLightTheme}
	class:editing-in-focus={isEditingInDarkFocus}
	role="application"
>
	<!-- Reading progress indicator -->
	{#if $currentFilePath}
		<div
			class="progress-line"
			style="width: {readingProgress * 100}%"
		></div>
	{/if}

	<!-- Top bar - minimal -->
	<header class="topbar" class:hidden={$focusMode}>
		<div class="topbar-left">
			<button
				class="icon-btn"
				on:click={openFileDialog}
				title="打开文件 ({modLabel}O)"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<path
						d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
					/>
				</svg>
			</button>
			{#if fileName}
				<span class="filename">{fileName}</span>
			{/if}
		</div>
		<div class="topbar-right">
			{#if $currentFilePath}
				<button
					class="icon-btn"
					class:active={$focusMode}
					on:click={() => void toggleFocusMode(!$focusMode)}
					title="专注模式 (F11 / Esc)"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
					>
						<circle cx="12" cy="12" r="3" />
						<path d="M3 12h3M18 12h3M12 3v3M12 18v3" />
					</svg>
				</button>
				<button
					class="icon-btn"
					class:active={$tocOpen}
					on:click={() => ($tocOpen = !$tocOpen)}
					title="目录 ({modLabel}T)"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
					>
						<path d="M4 6h16M4 12h12M4 18h8" />
					</svg>
				</button>
				<button
					class="icon-btn"
					class:active={$searchOpen}
					on:click={() => {
						$searchOpen = !$searchOpen;
						if ($searchOpen)
							tick().then(() => searchInput?.focus());
					}}
					title="搜索 ({modLabel}F)"
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="1.5"
					>
						<circle cx="11" cy="11" r="7" />
						<path d="M21 21l-4.35-4.35" />
					</svg>
				</button>
			{/if}
			<button
				class="icon-btn"
				class:active={$settingsOpen}
				on:click={() => ($settingsOpen = !$settingsOpen)}
				title="设置 ({modLabel},)"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					stroke-width="1.5"
				>
					<circle cx="12" cy="12" r="3" />
					<path
						d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83"
					/>
				</svg>
			</button>
		</div>
	</header>

	<!-- Search bar -->
	{#if $searchOpen}
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div class="search-overlay" class:has-results={searchMatches.length > 0} on:click={() => { $searchOpen = false; $searchQuery = ""; clearSearchHighlights(); }}>
			<div class="mac-search-bar" on:click|stopPropagation>
				<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" stroke-width="2">
					<circle cx="11" cy="11" r="7" />
					<path d="M21 21l-4.35-4.35" />
				</svg>
				<input
					bind:this={searchInput}
					bind:value={$searchQuery}
					on:input={scheduleSearch}
					placeholder="搜索..."
					class="search-input"
				/>
				{#if searchMatches.length > 0}
					<span class="search-count">{currentMatchIndex + 1} / {searchMatches.length}</span>
				{/if}
				<button class="search-nav" on:click={() => navigateSearch(-1)} title="上一条结果">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 15l-6-6-6 6" /></svg>
				</button>
				<button class="search-nav" on:click={() => navigateSearch(1)} title="下一条结果">
					<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6" /></svg>
				</button>
			</div>
		</div>
	{/if}

	<!-- TOC overlay -->
	{#if $tocOpen && tocItems.length > 0}
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="toc-overlay"
			on:click={() => ($tocOpen = false)}
			role="presentation"
		>
			<div
				class="toc-panel"
				on:click|stopPropagation
				on:keydown|stopPropagation
				role="presentation"
			>
				<div class="toc-title">目录</div>
				{#each tocItems as item}
					<button
						class="toc-item toc-level-{item.level}"
						on:click={() => scrollToHeading(item.id)}
					>
						{item.text}
					</button>
				{/each}
			</div>
		</div>
	{/if}

	<!-- Settings overlay -->
	{#if $settingsOpen}
		<!-- svelte-ignore a11y-click-events-have-key-events -->
		<!-- svelte-ignore a11y-no-static-element-interactions -->
		<div
			class="settings-overlay"
			on:click={() => ($settingsOpen = false)}
			role="presentation"
		>
			<div
				class="settings-panel"
				on:click|stopPropagation
				on:keydown|stopPropagation
				role="presentation"
			>
				<div class="settings-title">主题</div>
				<div class="theme-grid">
					{#each themePairs as pair}
						<button
							class="theme-option"
							class:active={$currentTheme.name ===
								pair.light.name}
							on:click={() => ($currentTheme = pair.light)}
						>
							<div
								class="theme-preview"
								style="background: {pair.light.vars[
									'--bg'
								]}; color: {pair.light.vars['--text']}"
							>
								Aa
							</div>
							<span>{pair.label} 浅色</span>
						</button>
						<button
							class="theme-option"
							class:active={$currentTheme.name === pair.dark.name}
							on:click={() => ($currentTheme = pair.dark)}
						>
							<div
								class="theme-preview"
								style="background: {pair.dark.vars[
									'--bg'
								]}; color: {pair.dark.vars['--text']}"
							>
								Aa
							</div>
							<span>{pair.label} 深色</span>
						</button>
					{/each}
				</div>
			</div>
		</div>
	{/if}

	<!-- Main content -->
	<main class="content" bind:this={contentEl}>
		{#if fileError}
			<div class="file-error" role="alert">{fileError}</div>
		{/if}
		{#if $isLoading}
			<div class="loading">
				<div class="loading-dot"></div>
			</div>
		{:else if $renderedHtml}
			<article class="article">
				{@html $renderedHtml}
			</article>
		{:else if $currentFilePath}
			<article class="article empty-file">
				<p>空白 Markdown 文件</p>
			</article>
		{:else}
			<div class="welcome">
				<div class="welcome-icon">
					<svg
						width="48"
						height="48"
						viewBox="0 0 24 24"
						fill="none"
						stroke="var(--text-faded)"
						stroke-width="1"
					>
						<path d="M4 19.5A2.5 2.5 0 016.5 17H20" />
						<path
							d="M6.5 2H20v20H6.5A2.5 2.5 0 014 19.5v-15A2.5 2.5 0 016.5 2z"
						/>
					</svg>
				</div>
				<p class="welcome-text">
					打开一个 Markdown 文件开始阅读				</p>
				<p class="welcome-hint">{modLabel}O 或将文件拖到此处</p>
			</div>
		{/if}
	</main>

	<!-- Spotlight overlays for focus mode -->
	{#if $focusMode && $renderedHtml}
		<div class="stage-spotlight-layer">
			<div class="dust-container">
				<!-- Limit particles strictly to the text reading width -->
				<div class="dust-bounds">
					{#each particles as p (p.id)}
						<div class="dust-particle" style="
							left: {p.left}%; 
							width: {p.size}px; height: {p.size}px;
							animation-duration: {p.duration}s;
							animation-delay: {p.delay}s;
							--p-opacity: {p.opacity};
						"></div>
					{/each}
				</div>
			</div>

			<div class="stage-lamp left"></div>
			<div class="stage-beam left"></div>

			<div class="stage-lamp right"></div>
			<div class="stage-beam right"></div>
		</div>
	{/if}

	{#if isEditingInDarkFocus}
		<div class="edit-orbit-container" style={editOrbitContainerStyle}>
			{#each editOrbitParticles as p (p.id)}
				<div class="edit-orbit-particle" style="
					width: {p.size}px; height: {p.size}px;
					--orbit-dur: {p.duration}s;
					--orbit-delay: {-p.duration * p.id / EDIT_ORBIT_COUNT}s;
					--appear-delay: {p.stagger}s;
					--p-opacity: {p.opacity};
				"></div>
			{/each}
		</div>
	{/if}
</div>

<style>
	/* ========== Base ========== */
	:global(*) {
		margin: 0;
		padding: 0;
		box-sizing: border-box;
	}

	:global(body) {
		overflow: hidden;
		background: var(--bg);
		color: var(--text);
		font-family:
			"Segoe UI",
			-apple-system,
			BlinkMacSystemFont,
			"PingFang SC",
			"Microsoft YaHei",
			"Noto Sans SC",
			sans-serif;
		transition:
			background 0.3s ease,
			color 0.3s ease;
	}

	:global(::selection) {
		background: var(--selection);
	}

	:global(::-webkit-scrollbar) {
		width: 6px;
	}
	:global(::-webkit-scrollbar-track) {
		background: transparent;
	}
	:global(::-webkit-scrollbar-thumb) {
		background: var(--scrollbar);
		border-radius: 3px;
	}
	:global(::-webkit-scrollbar-thumb:hover) {
		background: var(--scrollbar-hover);
	}

	.app {
		height: 100vh;
		display: flex;
		flex-direction: column;
		position: relative;
	}

	/* ========== Progress line ========== */
	.progress-line {
		position: fixed;
		top: 0;
		left: 0;
		height: 2px;
		background: var(--link);
		opacity: 0.3;
		z-index: 100;
		transition: width 0.1s linear;
	}

	/* ========== Top bar ========== */
	.topbar {
		display: flex;
		align-items: center;
		justify-content: space-between;
		height: 48px;
		padding: 0 16px;
		border-bottom: 1px solid var(--hr);
		flex-shrink: 0;
		-webkit-app-region: drag;
		user-select: none;
		transition: transform 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.4s cubic-bezier(0.2, 0.8, 0.2, 1), visibility 0.4s ease;
		z-index: 50;
		background: var(--bg);
	}
	
	.topbar.hidden {
		transform: translateY(-100%);
		opacity: 0;
		pointer-events: none;
		visibility: hidden;
	}

	.topbar-left,
	.topbar-right {
		display: flex;
		align-items: center;
		gap: 4px;
		-webkit-app-region: no-drag;
	}

	.filename {
		font-size: 13px;
		color: var(--text-secondary);
		margin-left: 8px;
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		border-radius: 10px;
		cursor: pointer;
		transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
		position: relative;
		overflow: hidden;
	}
	.icon-btn::after {
		content: ''; position: absolute; inset: 0;
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.1) 100%);
		opacity: 0; transition: opacity 0.3s ease;
		pointer-events: none;
	}
	.icon-btn:hover {
		background: var(--bg-secondary);
		border-color: var(--hr);
		color: var(--text);
		transform: translateY(-2px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1), inset 0 1px 1px rgba(255, 255, 255, 0.2);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}
	.icon-btn:hover::after {
		opacity: 1;
	}
	.icon-btn:active {
		transform: translateY(0);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
	}
	.icon-btn.active {
		color: var(--link);
		background: var(--bg-secondary);
		border-color: var(--hr);
	}

	/* ========== Search bar (macOS Spotlight Style) ========== */
	.search-overlay {
		position: fixed;
		inset: 0;
		z-index: 1000;
		background: rgba(0, 0, 0, 0.25);
		backdrop-filter: blur(12px);
		-webkit-backdrop-filter: blur(12px);
		display: flex;
		justify-content: center;
		padding-top: 20vh;
		animation: fadeIn 0.15s ease;
	}
.search-overlay.has-results {
		background: transparent;
		backdrop-filter: none;
		-webkit-backdrop-filter: none;
	}
	.is-light-theme .search-overlay {
		background: rgba(180, 180, 180, 0.1);
	}
.is-light-theme .search-overlay.has-results {
		background: transparent;
	}
	
	.mac-search-bar {
		width: 640px;
		max-width: 90vw;
		height: 64px;
		background: var(--bg-secondary);
		border: 1px solid var(--hr);
		border-radius: 16px;
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.3), inset 0 1px 1px rgba(255, 255, 255, 0.1);
		display: flex;
		align-items: center;
		padding: 0 20px;
		gap: 16px;
		animation: scaleIn 0.25s cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.is-light-theme .mac-search-bar {
		box-shadow: 0 16px 48px rgba(0, 0, 0, 0.15), inset 0 1px 1px rgba(255, 255, 255, 0.8);
		background: rgba(255, 255, 255, 0.8);
	}
	
	.search-input {
		flex: 1;
		border: none;
		background: none;
		color: var(--text);
		font-size: 20px;
		outline: none;
	}
	.search-input::placeholder {
		color: var(--text-faded);
	}
	.search-count {
		font-size: 14px;
		color: var(--text-faded);
		white-space: nowrap;
		margin-right: 8px;
	}
	.search-nav {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 32px;
		height: 32px;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		cursor: pointer;
		border-radius: 8px;
		transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
		position: relative;
		overflow: hidden;
	}
	.search-nav::after {
		content: ''; position: absolute; inset: 0;
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.1) 100%);
		opacity: 0; transition: opacity 0.3s ease;
		pointer-events: none;
	}
	.search-nav:hover {
		background: var(--bg);
		border-color: var(--hr);
		color: var(--text);
		transform: translateY(-1px);
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
	}
	.search-nav:hover::after {
		opacity: 1;
	}
	.search-nav:active {
		transform: translateY(0);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
	}

	/* ========== TOC ========== */
	.toc-overlay {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgba(0, 0, 0, 0.15);
		animation: fadeIn 0.15s ease;
	}
	.toc-panel {
		position: absolute;
		right: 0;
		top: 40px;
		bottom: 0;
		width: 280px;
		max-width: 80vw;
		background: var(--bg);
		border-left: 1px solid var(--hr);
		padding: 20px 16px;
		overflow-y: auto;
		animation: slideIn 0.2s ease;
	}
	.toc-title {
		font-size: 12px;
		font-weight: 600;
		color: var(--text-faded);
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 12px;
	}
	.toc-item {
		display: block;
		width: 100%;
		text-align: left;
		border: 1px solid transparent;
		background: transparent;
		color: var(--text-secondary);
		font-size: 13px;
		padding: 6px 8px;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.2s cubic-bezier(0.2, 0.8, 0.2, 1);
		line-height: 1.4;
	}
	.toc-item:hover {
		background: var(--bg-secondary);
		color: var(--text);
		transform: translateX(2px) translateY(-1px);
		box-shadow: 0 2px 8px rgba(0,0,0,0.06);
		border-color: var(--hr);
	}
	.toc-level-1 {
		padding-left: 8px;
		font-weight: 600;
	}
	.toc-level-2 {
		padding-left: 20px;
	}
	.toc-level-3 {
		padding-left: 32px;
		font-size: 12px;
	}
	.toc-level-4 {
		padding-left: 44px;
		font-size: 12px;
	}
	.toc-level-5 {
		padding-left: 56px;
		font-size: 12px;
	}
	.toc-level-6 {
		padding-left: 68px;
		font-size: 12px;
	}

	/* ========== Settings ========== */
	.settings-overlay {
		position: fixed;
		inset: 0;
		z-index: 40;
		background: rgba(0, 0, 0, 0.15);
		display: flex;
		align-items: center;
		justify-content: center;
		animation: fadeIn 0.15s ease;
	}
	.settings-panel {
		background: var(--bg);
		border: 1px solid var(--hr);
		border-radius: 12px;
		padding: 24px;
		max-width: 400px;
		width: 90vw;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.12);
		animation: scaleIn 0.2s ease;
	}
	.settings-title {
		font-size: 14px;
		font-weight: 600;
		color: var(--text);
		margin-bottom: 16px;
	}
	.theme-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 8px;
	}
	.theme-option {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		padding: 10px;
		border: 1.5px solid var(--hr);
		border-radius: 12px;
		background: var(--bg);
		cursor: pointer;
		transition: all 0.3s cubic-bezier(0.2, 0.8, 0.2, 1);
		position: relative;
		overflow: hidden;
	}
	.theme-option::after {
		content: ''; position: absolute; inset: 0;
		background: linear-gradient(135deg, rgba(255, 255, 255, 0.4) 0%, rgba(255, 255, 255, 0) 50%, rgba(255, 255, 255, 0.1) 100%);
		opacity: 0; transition: opacity 0.3s ease;
		pointer-events: none;
	}
	.theme-option:hover {
		border-color: var(--text-faded);
		transform: translateY(-2px);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.08), inset 0 1px 1px rgba(255, 255, 255, 0.2);
	}
	.theme-option:hover::after {
		opacity: 1;
	}
	.theme-option:active {
		transform: translateY(0);
		box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
	}
	.theme-option.active {
		border-color: var(--link);
		background: var(--bg-secondary);
	}
	.theme-option span {
		font-size: 11px;
		color: var(--text-secondary);
	}
	.theme-preview {
		width: 100%;
		height: 40px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 16px;
		font-weight: 500;
	}

	/* ========== Main content ========== */
	.content {
		flex: 1;
		overflow-y: auto;
		overflow-x: hidden;
		scroll-behavior: smooth;
	}
	.app.focus-key-scroll-active .content {
		scroll-behavior: auto;
	}

	.article {
		--article-padding-x: 48px;
		--article-padding-top: 64px;
		--article-padding-bottom: 120px;
		max-width: 760px;
		margin: 0 auto;
		padding: var(--article-padding-top) var(--article-padding-x)
			var(--article-padding-bottom);
		line-height: 1.8;
		font-size: 16px;
		position: relative;
		z-index: 20;
		animation: contentFadeIn 0.3s ease;
		overflow-wrap: anywhere;
	}

	.app:not(.focus-mode) :global(.article > *) {
		content-visibility: auto;
		contain-intrinsic-size: auto 3em;
	}
	.app:not(.focus-mode) :global(.article pre),
	.app:not(.focus-mode) :global(.article table),
	.app:not(.focus-mode) :global(.article blockquote) {
		contain-intrinsic-size: auto 12em;
	}

	.file-error {
		margin: 16px auto 0;
		max-width: 760px;
		padding: 10px 14px;
		border: 1px solid var(--hr);
		border-radius: 8px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: 13px;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}

	.empty-file {
		color: var(--text-faded);
	}
	
	.app.focus-mode .article {
		font-size: 18px; /* enlarge text in focus mode */
	}

	/* ========== Typography ========== */
	:global(.article h1) {
		font-size: 2em;
		font-weight: 700;
		color: var(--heading);
		margin: 2em 0 0.8em;
		line-height: 1.3;
		letter-spacing: -0.02em;
	}
	:global(.article h1:first-child) {
		margin-top: 0;
	}
	:global(.article h2) {
		font-size: 1.5em;
		font-weight: 600;
		color: var(--heading);
		margin: 1.8em 0 0.6em;
		line-height: 1.35;
		padding-bottom: 0.3em;
		border-bottom: 1px solid var(--hr);
	}
	:global(.article h3) {
		font-size: 1.25em;
		font-weight: 600;
		color: var(--heading);
		margin: 1.5em 0 0.5em;
		line-height: 1.4;
	}
	:global(.article h4),
	:global(.article h5),
	:global(.article h6) {
		font-size: 1.05em;
		font-weight: 600;
		color: var(--heading);
		margin: 1.2em 0 0.4em;
	}

	:global(.article p) {
		margin: 0.8em 0;
		color: var(--text);
	}

	:global(.article a) {
		color: var(--link);
		text-decoration: none;
		border-bottom: 1px solid transparent;
		transition: border-color 0.15s ease;
	}
	:global(.article a:hover) {
		color: var(--link-hover);
		border-bottom-color: var(--link-hover);
	}

	:global(.article strong) {
		font-weight: 600;
		color: var(--heading);
	}

	:global(.article em) {
		font-style: italic;
	}

	:global(.article blockquote) {
		margin: 1.2em 0;
		padding: 0.8em 1.2em;
		border-left: 3px solid var(--blockquote-border);
		color: var(--blockquote-text);
		background: var(--bg-secondary);
		border-radius: 0 6px 6px 0;
	}
	:global(.article blockquote p) {
		margin: 0.3em 0;
	}

	:global(.article code) {
		font-family: "Cascadia Code", "Fira Code", "JetBrains Mono", "Consolas",
			monospace;
		font-size: 0.88em;
		background: var(--code-bg);
		color: var(--code-text);
		padding: 0.15em 0.4em;
		border-radius: 4px;
	}

	:global(.article pre) {
		margin: 1.2em 0;
		border-radius: 8px;
		overflow-x: auto;
		font-size: 0.88em;
		line-height: 1.6;
	}
	:global(.article pre code) {
		background: none;
		padding: 0;
		border-radius: 0;
	}
	:global(.article .shiki) {
		padding: 1em 1.2em;
		border-radius: 8px;
		overflow-x: auto;
	}

	:global(.article ul),
	:global(.article ol) {
		margin: 0.8em 0;
		padding-left: 1.8em;
	}
	:global(.article li) {
		margin: 0.3em 0;
	}
	:global(.article li > ul),
	:global(.article li > ol) {
		margin: 0.2em 0;
	}

	:global(.article hr) {
		border: none;
		height: 1px;
		background: var(--hr);
		margin: 2em 0;
	}

	:global(.article img) {
		max-width: 100%;
		height: auto;
		display: block;
		margin: 1.5em auto;
		border-radius: 6px;
		box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
	}

	:global(.article table) {
		width: 100%;
		border-collapse: collapse;
		margin: 1.2em 0;
		font-size: 0.92em;
	}
	:global(.article th),
	:global(.article td) {
		padding: 0.6em 1em;
		border: 1px solid var(--table-border);
		text-align: left;
	}
	:global(.article th) {
		font-weight: 600;
		background: var(--bg-secondary);
	}
	:global(.article tr:nth-child(even) td) {
		background: var(--table-stripe);
	}

	/* ========== Inline editing ========== */
	:global(.editing) {
		outline: none;
		border-radius: 4px;
		cursor: text;
		animation: editBreath 2.5s ease-in-out infinite;
	}
	@keyframes editBreath {
		0%, 100% { box-shadow: 0 0 0 1.5px var(--selection); }
		50% { box-shadow: 0 0 0 2px var(--selection), 0 0 10px var(--selection); }
	}

	/* ========== Focus mode ========== */
	.focus-mode :global(.article > *) {
		transition:
			filter 0.4s ease,
			opacity 0.4s ease,
			transform 0.4s ease,
			text-shadow 0.4s ease,
			color 0.4s ease;
	}
	.focus-mode :global([data-focus-block="true"] > td),
	.focus-mode :global([data-focus-block="true"] > th) {
		transition:
			filter 0.4s ease,
			opacity 0.4s ease,
			color 0.4s ease,
			text-shadow 0.4s ease;
	}
	.focus-key-scroll-active :global(.article > *),
	.focus-key-scroll-active :global([data-focus-block="true"] > td),
	.focus-key-scroll-active :global([data-focus-block="true"] > th) {
		transition: none;
	}
	.focus-mode :global(.article blockquote),
	.focus-mode :global(.article pre) {
		background: transparent;
		border-color: transparent;
	}


	/* ========== Edit orbit particles ========== */
	.dust-container {
		transition: opacity 0.5s ease;
	}
	.editing-in-focus .dust-container {
		opacity: 0;
	}

	.edit-orbit-container {
		position: fixed;
		pointer-events: none;
		z-index: 100;
	}
	.edit-orbit-particle {
		position: absolute;
		background: #fff;
		border-radius: 50%;
		filter: blur(0.5px);
		box-shadow: 0 0 6px 2px rgba(255,255,255,0.4);
		transform: translate(-50%, -50%);
		opacity: 0;
		animation-name: orbitBorder, editParticleAppear;
		animation-duration: var(--orbit-dur, 8s), 0.4s;
		animation-timing-function: linear, ease;
		animation-delay: var(--orbit-delay, 0s), var(--appear-delay, 0s);
		animation-iteration-count: infinite, 1;
		animation-fill-mode: none, forwards;
	}
	@keyframes orbitBorder {
		0%, 100% { left: 0; top: 0; }
		25% { left: 100%; top: 0; }
		50% { left: 100%; top: 100%; }
		75% { left: 0; top: 100%; }
	}
	@keyframes editParticleAppear {
		from { opacity: 0; transform: translate(-50%, -50%) scale(3); }
		to { opacity: var(--p-opacity); transform: translate(-50%, -50%) scale(1); }
	}

	/* Stage Spotlight layer */
	.stage-spotlight-layer {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 10;
		animation: fadeIn 0.5s ease;
	}

	.dust-container {
		position: absolute;
		/* Lock vertical space roughly between lamps and spotlight target */
		top: calc(var(--anchor-y, 38vh)); 
		bottom: calc(100vh - (var(--spotlight-top, 50vh) + var(--spotlight-height, 100px)));
		left: 0; right: 0;
		overflow: hidden;
		pointer-events: none;
		z-index: 13;
	}
	.is-light-theme .dust-container {
		display: none; /* Removed particle effect in light mode completely */
	}
	.dust-bounds {
		position: absolute;
		/* Strict bounds: do not exceed the textual horizontal space */
		left: var(--spotlight-left, 30vw);
		width: calc(var(--spotlight-right, 70vw) - var(--spotlight-left, 30vw));
		height: 100%;
		/* Fade out particles progressively before they reach the bottom (text block) */
		mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%);
		-webkit-mask-image: linear-gradient(to bottom, transparent 0%, black 15%, black 60%, transparent 100%);
	}
	.dust-particle {
		position: absolute;
		bottom: -10px; /* Start from below the view */
		background: #fff;
		border-radius: 50%;
		filter: blur(0.5px);
		box-shadow: 0 0 6px 2px rgba(255,255,255,0.4);
		animation-name: floatParticle;
		animation-timing-function: linear;
		animation-iteration-count: infinite;
	}
	@keyframes floatParticle {
		0% { transform: translateY(0); opacity: 0; }
		20% { opacity: var(--p-opacity); }
		60% { opacity: var(--p-opacity); }
		100% { transform: translateY(-40vh); opacity: 0; }
	}

	.stage-lamp {
		position: absolute;
		top: var(--anchor-y, 38vh);
		width: 12px;
		height: 48px;
		background: rgba(255, 255, 255, 0.9);
		border-radius: 6px;
		box-shadow: 0 0 20px 8px var(--spotlight-color, rgba(255, 255, 255, 0.2)), 0 0 10px rgba(255, 255, 255, 0.8) inset;
		transform: translateY(-50%);
		z-index: 12;
		transition: top 0.1s ease-out;
		filter: blur(1px);
	}
	.focus-scroll-active .stage-lamp {
		transition: none;
	}
	.is-light-theme .stage-lamp {
		background: rgba(0, 0, 0, 0.4);
		box-shadow: 0 0 20px 8px rgba(0, 0, 0, 0.15), 0 0 10px rgba(0, 0, 0, 0.2) inset;
	}
	.stage-lamp.left { left: -4px; }
	.stage-lamp.right { right: -4px; }

	.stage-beam {
		position: absolute;
		top: 0; left: 0; width: 100vw; height: 100vh;
		z-index: 11;
		transition: clip-path 0.4s cubic-bezier(0.2, 0.8, 0.2, 1);
		will-change: clip-path;
		opacity: 0.8;
	}
	.focus-scroll-active .stage-beam {
		transition: none;
	}
	.is-light-theme .stage-beam {
		opacity: 0.1;
	}

	.stage-beam.left {
		clip-path: polygon(
			-10px calc(var(--anchor-y, 38vh) - 8px), 
			calc(var(--spotlight-left, 30vw) + 10px) calc(var(--spotlight-top, 50vh) - 16px), 
			calc(var(--spotlight-left, 30vw) + 10px) calc(var(--spotlight-top, 50vh) + var(--spotlight-height, 100px) + 16px), 
			-10px calc(var(--anchor-y, 38vh) + 8px)
		);
		/* Subtle aberration exactly at the beam edge */
		background: linear-gradient(to right, 
			rgba(255,255,255,0.1) 0%, 
			var(--spotlight-color, rgba(255,255,255,0.08)) 25%, 
			transparent var(--spotlight-left, 30vw)
		);
		mask-image: linear-gradient(to right, #000 0%, transparent var(--spotlight-left, 30vw));
		-webkit-mask-image: linear-gradient(to right, #000 0%, transparent var(--spotlight-left, 30vw));
		/* Tighter blur for sharper beam */
		filter: blur(3px); 
	}
	.is-light-theme .stage-beam.left {
		background: linear-gradient(to right, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.1) 25%, transparent var(--spotlight-left, 30vw));
	}
	
	.stage-beam.right {
		clip-path: polygon(
			calc(100vw + 10px) calc(var(--anchor-y, 38vh) - 8px), 
			calc(var(--spotlight-right, 70vw) - 10px) calc(var(--spotlight-top, 50vh) - 16px), 
			calc(var(--spotlight-right, 70vw) - 10px) calc(var(--spotlight-top, 50vh) + var(--spotlight-height, 100px) + 16px), 
			calc(100vw + 10px) calc(var(--anchor-y, 38vh) + 8px)
		);
		background: linear-gradient(to left, 
			rgba(255,255,255,0.1) 0%, 
			var(--spotlight-color, rgba(255,255,255,0.08)) 25%, 
			transparent calc(100vw - var(--spotlight-right, 70vw))
		);
		mask-image: linear-gradient(to left, #000 0%, transparent calc(100vw - var(--spotlight-right, 70vw)));
		-webkit-mask-image: linear-gradient(to left, #000 0%, transparent calc(100vw - var(--spotlight-right, 70vw)));
		filter: blur(3px);
	}
	.is-light-theme .stage-beam.right {
		background: linear-gradient(to left, rgba(0,0,0,0.2) 0%, rgba(0,0,0,0.1) 25%, transparent calc(100vw - var(--spotlight-right, 70vw)));
	}

	/* ========== Search highlights ========== */
	:global(mark.search-match) {
		background: var(--search-highlight);
		color: inherit;
		border-radius: 2px;
		padding: 1px 0;
	}
	:global(mark.search-match.search-current) {
		background: var(--link);
		color: var(--bg);
	}

	/* ========== Welcome ========== */
	.welcome {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		gap: 16px;
		animation: contentFadeIn 0.5s ease;
	}
	.welcome-icon {
		opacity: 0.4;
	}
	.welcome-text {
		font-size: 16px;
		color: var(--text-secondary);
	}
	.welcome-hint {
		font-size: 13px;
		color: var(--text-faded);
	}

	/* ========== Loading ========== */
	.loading {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
	}
	.loading-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--text-faded);
		animation: pulse 1s ease-in-out infinite;
	}

	/* ========== Animations ========== */
	@keyframes fadeIn {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}
	@keyframes slideIn {
		from {
			transform: translateX(20px);
			opacity: 0;
		}
		to {
			transform: translateX(0);
			opacity: 1;
		}
	}
	@keyframes scaleIn {
		from {
			transform: scale(0.95);
			opacity: 0;
		}
		to {
			transform: scale(1);
			opacity: 1;
		}
	}
	@keyframes contentFadeIn {
		from {
			opacity: 0;
			transform: translateY(8px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@keyframes pulse {
		0%,
		100% {
			opacity: 0.3;
			transform: scale(0.8);
		}
		50% {
			opacity: 1;
			transform: scale(1);
		}
	}
</style>










