<script lang="ts">
	import { onMount, tick } from "svelte";
	import { invoke } from "@tauri-apps/api/core";
	import { open } from "@tauri-apps/plugin-dialog";
	import {
		renderMarkdown,
		extractToc,
		addHeadingIds,
		type TocItem,
	} from "$lib/render/markdown";
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
	let searchMatches: Element[] = [];
	let currentMatchIndex = -1;
	let editingParagraph: HTMLElement | null = null;
	let originalText = "";
	let originalTextContent = "";
	let focusBlocks: HTMLElement[] = [];
	let focusUpdateFrame: number | null = null;
	let queuedFocusIndex: number | undefined;
	let isFocusScrollActive = false;
	let focusScrollEndTimer: ReturnType<typeof setTimeout> | null = null;
	let searchMatchBlocks = new Set<HTMLElement>();
	let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	let saveStateTimer: ReturnType<typeof setTimeout> | null = null;
	let lastFocusRenderSignature = "";
	let spotlightHeight = 100;
	let focusLockedIndex: number | null = null;

	let isEditingInDarkFocus = false;
	let editOrbitContainerStyle = '';
	const EDIT_ORBIT_COUNT = 20;
	let editOrbitParticles: {id: number, size: number, duration: number, opacity: number, stagger: number}[] = [];

	let particles: {id: number, left: number, size: number, duration: number, delay: number, opacity: number}[] = [];

	$: if ($focusMode && typeof window !== "undefined") {
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
	} else if (!$focusMode) {
		particles = [];
	}

	let readingProgress = 0;
	const FOCUS_ANCHOR_RATIO = 0.5;
	const FOCUS_EDGE_SPACE_RATIO = 0.34;
	const FOCUS_EDGE_SPACE_MIN = 140;
	const FOCUS_WHEEL_STEP = 48;
	const FOCUS_SCROLL_ACTIVE_MS = 120;
	let focusEdgeSpace = 0;
	let focusWheelDelta = 0;
	let focusWheelResetTimer: ReturnType<typeof setTimeout> | null = null;
	let lastFocusedIdx = -1;

	function isTextInputTarget(target: EventTarget | null) {
		const el = target instanceof HTMLElement ? target : null;
		return !!el?.closest("input, textarea, select, [contenteditable='true']");
	}

	function clearFocusScrollActive() {
		isFocusScrollActive = false;
		focusLockedIndex = null;
		if (focusScrollEndTimer) {
			clearTimeout(focusScrollEndTimer);
			focusScrollEndTimer = null;
		}
	}

	function markFocusScrollActive() {
		isFocusScrollActive = true;
		if (focusScrollEndTimer) {
			clearTimeout(focusScrollEndTimer);
		}
		focusScrollEndTimer = setTimeout(() => {
			isFocusScrollActive = false;
			focusLockedIndex = null;
			focusScrollEndTimer = null;
		}, FOCUS_SCROLL_ACTIVE_MS);
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
		if (nextState) {
			$focusMode = true;
			await tick();
			enterFocusMode();
			return;
		}
		exitFocusMode();
		$focusMode = false;
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
			if (e.ctrlKey && e.key === "o") {
				e.preventDefault();
				openFileDialog();
				return;
			}

			if (e.ctrlKey && e.key === "f") {
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

			if (e.ctrlKey && e.key === "t") {
				e.preventDefault();
				$tocOpen = !$tocOpen;
				return;
			}

			if (e.key === "F11" || (e.ctrlKey && e.shiftKey && e.key === "F")) {
				e.preventDefault();
				void toggleFocusMode(!$focusMode);
				return;
			}

			if ($focusMode && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextInputTarget(e.target)) {
				if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
					e.preventDefault();
					moveFocus(-1);
					return;
				}
				if (e.key === "ArrowDown" || e.key === "ArrowRight") {
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

			if (e.ctrlKey && e.key === ",") {
				e.preventDefault();
				$settingsOpen = !$settingsOpen;
			}
		};

		const handleScroll = () => {
			if (!contentEl) return;
			const scrollTop = contentEl.scrollTop;
			const scrollHeight = contentEl.scrollHeight - contentEl.clientHeight;
			readingProgress = scrollHeight > 0 ? scrollTop / scrollHeight : 0;

			if ($focusMode) {
				markFocusScrollActive();
				scheduleFocusUpdate(focusLockedIndex ?? undefined);
			}

			if ($currentFilePath && !saveStateTimer) {
				saveStateTimer = setTimeout(() => {
					saveStateTimer = null;
					saveState();
				}, 5000);
			}
		};

		const handleWheel = (e: WheelEvent) => {
			if (!contentEl || !$focusMode) return;
			const blocks = getFocusBlocks();
			if (blocks.length === 0 || Math.abs(e.deltaY) < 0.01) return;

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

			const direction = focusWheelDelta > 0 ? 1 : -1;
			focusWheelDelta = 0;
			moveFocus(direction);
		};

		const handleDblClick = (e: MouseEvent) => {
			const target = (e.target as HTMLElement)?.closest("p, h1, h2, h3, h4, h5, h6, li, blockquote");
			if (target && contentEl.querySelector(".article")?.contains(target)) {
				startEdit(target as HTMLElement);
			}
		};

		window.addEventListener("keydown", handleKeydown);
		contentEl?.addEventListener("scroll", handleScroll);
		contentEl?.addEventListener("wheel", handleWheel, { passive: false });
		contentEl?.addEventListener("dblclick", handleDblClick);
		window.addEventListener("beforeunload", saveState);

		return () => {
			window.removeEventListener("keydown", handleKeydown);
			contentEl?.removeEventListener("scroll", handleScroll);
			contentEl?.removeEventListener("wheel", handleWheel);
			contentEl?.removeEventListener("dblclick", handleDblClick);
			window.removeEventListener("beforeunload", saveState);
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
		if ($currentFilePath) {
			if (saveStateTimer) { clearTimeout(saveStateTimer); saveStateTimer = null; }
			saveState();
		}
		$isLoading = true;
		$currentFilePath = path;
		fileName = path.split(/[\\/]/).pop() || "";

		try {
			const result = await invoke<{content: string, encoding: string}>("read_markdown_file", {
				path,
			});
			$markdownSource = result.content;
			fileEncoding = result.encoding;

			let html = await renderMarkdown(result.content);
			html = addHeadingIds(html);
			$renderedHtml = html;
			tocItems = extractToc(html);

			await tick();

			try {
				const state: { scroll_position: number; bookmarks: number[] } =
					await invoke("load_reading_state", { path });
				if (state.scroll_position > 0 && contentEl) {
					contentEl.scrollTop = state.scroll_position;
				}
			} catch {
				// No saved state, start from top
			}

		} catch (err) {
			console.error("Failed to open file:", err);
		} finally {
			$isLoading = false;
			await tick();

			refreshFocusBlocks();
			if ($searchQuery.trim()) {
				performSearch();
			}
			if ($focusMode) {
				await tick();
				enterFocusMode();
			}
		}
	}

	function startEdit(el: HTMLElement) {
		if (editingParagraph) cancelEdit();
		if (!$currentFilePath) return;
		editingParagraph = el;
		originalText = el.innerHTML;
		originalTextContent = el.textContent || '';
		el.setAttribute("contenteditable", "true");
		el.classList.add("editing");
		el.focus();

		el.addEventListener("blur", finishEdit, { once: true });
		el.addEventListener("keydown", handleEditKeydown);

		const isDark = !$currentTheme.name.includes('light');
		if ($focusMode && isDark) {
			const rect = el.getBoundingClientRect();
			const pad = 8;
			editOrbitContainerStyle = `left:${rect.left - pad}px;top:${rect.top - pad}px;width:${rect.width + pad * 2}px;height:${rect.height + pad * 2}px`;
			editOrbitParticles = Array.from({length: EDIT_ORBIT_COUNT}).map((_, i) => ({
				id: i,
				size: Math.random() * 2 + 1,
				duration: 8 + Math.random() * 4,
				opacity: Math.random() * 0.5 + 0.5,
				stagger: i * 0.025,
			}));
			isEditingInDarkFocus = true;
		}
	}

	function handleEditKeydown(e: KeyboardEvent) {
		if (e.key === "Escape") {
			e.preventDefault();
			cancelEdit();
		} else if (e.key === "Enter") {
			e.preventDefault();
			finishEdit();
		}
	}

	function cleanupEditOrbit() {
		isEditingInDarkFocus = false;
		editOrbitParticles = [];
	}

	function cancelEdit() {
		if (!editingParagraph) return;
		const el = editingParagraph;
		editingParagraph = null;
		el.removeEventListener("blur", finishEdit);
		el.removeEventListener("keydown", handleEditKeydown);
		el.innerHTML = originalText;
		el.removeAttribute("contenteditable");
		el.classList.remove("editing");
		cleanupEditOrbit();
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

		return null;
	}

	async function finishEdit() {
		if (!editingParagraph) return;
		const el = editingParagraph;
		const newTextContent = el.textContent || '';

		editingParagraph = null;
		el.removeEventListener("blur", finishEdit);
		el.removeEventListener("keydown", handleEditKeydown);
		el.removeAttribute("contenteditable");
		el.classList.remove("editing");
		cleanupEditOrbit();

		if (newTextContent === originalTextContent) return;
		if (!$currentFilePath) return;

		const sourceStart = parseInt(el.dataset.sourceStart || '-1');
		const sourceEnd = parseInt(el.dataset.sourceEnd || '-1');
		if (sourceStart < 1 || sourceEnd < 1) return;

		const lines = $markdownSource.split('\n');
		const sourceBlock = lines.slice(sourceStart - 1, sourceEnd).join('\n');
		const patched = applyTextDiff(originalTextContent, newTextContent, sourceBlock);
		if (patched === null) return;

		const patchedLines = patched.split('\n');
		lines.splice(sourceStart - 1, sourceEnd - sourceStart + 1, ...patchedLines);
		$markdownSource = lines.join('\n');

		try {
			await invoke('save_markdown_file', { path: $currentFilePath, content: $markdownSource, encoding: fileEncoding });
		} catch (err) {
			console.error('Failed to save:', err);
		}

		saveState();
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

	function refreshFocusBlocks() {
		const article = getArticleElement();
		if (!article) {
			focusBlocks = [];
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
		return focusBlocks;
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
		}
	}

	function getBlockForNode(node: Node | null) {
		const element = node instanceof Element ? node : node?.parentElement ?? null;
		return element?.closest("[data-focus-block='true']") as HTMLElement | null;
	}

	function getSearchPreferredFocusIndex() {
		const block = currentMatchIndex >= 0 ? getBlockForNode(searchMatches[currentMatchIndex]) : null;
		if (!block) return undefined;
		const index = Number(block.dataset.focusIndex ?? "-1");
		return Number.isFinite(index) && index >= 0 ? index : undefined;
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
		const anchorY = getFocusAnchorY();
		let hitIdx = 0;
		let bestScore = Number.POSITIVE_INFINITY;

		for (let i = 0; i < blocks.length; i++) {
			const rect = blocks[i].getBoundingClientRect();
			const nearestY = Math.min(Math.max(anchorY, rect.top), rect.bottom);
			const edgeDistance = Math.abs(nearestY - anchorY);
			const centerDistance = Math.abs((rect.top + rect.bottom) / 2 - anchorY);
			const stabilityBias = i === lastFocusedIdx ? 24 : 0;
			const score = edgeDistance * 1000 + centerDistance - stabilityBias;

			if (score < bestScore) {
				bestScore = score;
				hitIdx = i;
			}
		}

		return hitIdx;
	}

	function clampFocusIndex(index: number, length: number) {
		return Math.max(0, Math.min(index, length - 1));
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
	}

	function scrollBlockToFocusPosition(block: HTMLElement) {
		if (!contentEl) return;
		const contentRect = contentEl.getBoundingClientRect();
		const blockRect = block.getBoundingClientRect();
		const currentBlockCenter =
			contentEl.scrollTop +
			(blockRect.top - contentRect.top) +
			blockRect.height / 2;
		const targetScrollTop = currentBlockCenter - getFocusAnchorOffset();
		const maxScrollTop = Math.max(0, contentEl.scrollHeight - contentEl.clientHeight);
		contentEl.scrollTop = Math.max(0, Math.min(targetScrollTop, maxScrollTop));
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
		for (const target of getFocusStyleTargets(block)) {
			target.style.filter = styles.filter;
			target.style.opacity = styles.opacity;
			target.style.transform = allowScale ? styles.transform : "";
			target.style.textShadow = styles.textShadow;
			target.style.color = styles.color;
		}
	}

	function applyFocusStyles(blocks: HTMLElement[], hitIdx: number) {
		const currentSearchBlock = currentMatchIndex >= 0
			? getBlockForNode(searchMatches[currentMatchIndex])
			: null;
		const signature = `${hitIdx}|${currentMatchIndex}|${searchMatchBlocks.size}`;
		if (signature === lastFocusRenderSignature) {
			lastFocusedIdx = hitIdx;
			return;
		}
		lastFocusRenderSignature = signature;
		lastFocusedIdx = hitIdx;

		const glowColor = getComputedStyle(document.documentElement)
			.getPropertyValue("--focus-text-glow")
			.trim();
		const hasGlow = glowColor && !glowColor.includes("0, 0, 0, 0") && glowColor !== "transparent";

		for (let i = 0; i < blocks.length; i++) {
			const block = blocks[i];
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

			if (dist === 1) {
				applyStylesToBlock(block, {
					filter: "blur(1.2px)",
					opacity: "0.3",
					transform: "scale(0.995)",
					textShadow: "none",
					color: "",
				});
			} else if (dist === 2) {
				applyStylesToBlock(block, {
					filter: "blur(2.8px)",
					opacity: "0.15",
					transform: "scale(0.99)",
					textShadow: "none",
					color: "",
				});
			} else if (dist === 3) {
				applyStylesToBlock(block, {
					filter: "blur(4.5px)",
					opacity: "0.08",
					transform: "scale(0.985)",
					textShadow: "none",
					color: "",
				});
			} else {
				const blur = Math.min(4.5 + (dist - 3) * 1.5, 12);
				const opacity = Math.max(0.01, 0.05 - (dist - 3) * 0.01);
				applyStylesToBlock(block, {
					filter: `blur(${blur}px)`,
					opacity: `${opacity}`,
					transform: "scale(0.98)",
					textShadow: "none",
					color: "",
				});
			}
		}
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
		scrollBlockToFocusPosition(blocks[nextIdx]);
		updateSpotlightPosition();
	}

	function clearFocusStyles() {
		for (const block of getFocusBlocks()) {
			clearBlockFocusStyle(block);
		}
		lastFocusedIdx = -1;
		lastFocusRenderSignature = "";
	}

	function updateSpotlightPosition() {
		if (!contentEl) return;
		const blocks = getFocusBlocks();
		if (lastFocusedIdx < 0 || lastFocusedIdx >= blocks.length) return;

		const activeBlock = blocks[lastFocusedIdx];
		const rect = activeBlock.getBoundingClientRect();
		const anchorY = getFocusAnchorY();
		spotlightHeight += (rect.height - spotlightHeight) * 0.24;
		if (Math.abs(rect.height - spotlightHeight) < 0.5) {
			spotlightHeight = rect.height;
		}
		const docStyle = document.documentElement.style;
		docStyle.setProperty("--spotlight-top", `${anchorY - spotlightHeight / 2}px`);
		docStyle.setProperty("--spotlight-height", `${spotlightHeight}px`);
		docStyle.setProperty("--spotlight-left", `${rect.left}px`);
		docStyle.setProperty("--spotlight-right", `${rect.right}px`);
		docStyle.setProperty("--anchor-y", `${anchorY}px`);
	}

	function enterFocusMode() {
		refreshFocusBlocks();
		const preservePosition = (contentEl?.scrollTop ?? 0) > 0;
		applyFocusSpacing({ preservePosition });
		focusWheelDelta = 0;
		lastFocusedIdx = -1;
		lastFocusRenderSignature = "";
		spotlightHeight = 100;

		const preferredIdx = getSearchPreferredFocusIndex();
		updateFocusParagraph(preferredIdx);
		const blocks = getFocusBlocks();
		if (blocks.length === 0 || lastFocusedIdx < 0) return;

		focusLockedIndex = lastFocusedIdx;
		markFocusScrollActive();
		scrollBlockToFocusPosition(blocks[lastFocusedIdx]);
		updateFocusParagraph(lastFocusedIdx);
		updateSpotlightPosition();
	}

	function exitFocusMode() {
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
	}

	function clearSearchHighlights() {
		if (searchDebounceTimer) { clearTimeout(searchDebounceTimer); searchDebounceTimer = null; }
		if (contentEl) {
			const marks = contentEl.querySelectorAll("mark.search-match");
			marks.forEach((mark) => {
				const parent = mark.parentNode;
				if (parent) {
					parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
					parent.normalize();
				}
			});
		}

		searchMatchBlocks.forEach((block) => block.classList.remove("search-result-block"));
		searchMatchBlocks = new Set<HTMLElement>();
		searchMatches = [];
		currentMatchIndex = -1;
		lastFocusRenderSignature = "";
		if ($focusMode) {
			scheduleFocusUpdate(lastFocusedIdx >= 0 ? lastFocusedIdx : undefined);
		}
	}

	function performSearch() {
		clearSearchHighlights();
		if (!$searchQuery || !contentEl) return;

		refreshFocusBlocks();
		const article = contentEl.querySelector(".article");
		if (!article) return;

		const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT);
		const query = $searchQuery.toLowerCase();
		const matchNodes: { node: Text; index: number }[] = [];

		while (walker.nextNode()) {
			const node = walker.currentNode as Text;
			const text = node.textContent?.toLowerCase() || "";
			let idx = text.indexOf(query);
			while (idx !== -1) {
				matchNodes.push({ node, index: idx });
				idx = text.indexOf(query, idx + 1);
			}
		}

		searchMatches = [];
		for (let i = matchNodes.length - 1; i >= 0; i--) {
			const { node, index } = matchNodes[i];
			const range = document.createRange();
			range.setStart(node, index);
			range.setEnd(node, index + $searchQuery.length);
			const mark = document.createElement("mark");
			mark.className = "search-match";
			range.surroundContents(mark);
			searchMatches.unshift(mark);
			const block = getBlockForNode(mark);
			if (block) {
				searchMatchBlocks.add(block);
				block.classList.add("search-result-block");
			}
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
		searchMatches[currentMatchIndex]?.classList.remove("search-current");
		currentMatchIndex =
			(currentMatchIndex + direction + searchMatches.length) %
			searchMatches.length;
		highlightCurrentMatch();
	}

	function highlightCurrentMatch() {
		const match = searchMatches[currentMatchIndex];
		if (!match) return;

		match.classList.add("search-current");
		const block = getBlockForNode(match);
		if ($focusMode && block) {
			const index = Number(block.dataset.focusIndex ?? "-1");
			if (Number.isFinite(index) && index >= 0) {
				focusLockedIndex = index;
				markFocusScrollActive();
				updateFocusParagraph(index);
				scrollBlockToFocusPosition(block);
				updateSpotlightPosition();
				return;
			}
		}

		match.scrollIntoView({ behavior: "smooth", block: "center" });
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

	function handleDrop(e: DragEvent) {
		e.preventDefault();
		const files = e.dataTransfer?.files;
		if (files && files.length > 0) {
			const file = files[0];
			if (file.name.endsWith(".md") || file.name.endsWith(".markdown")) {
				const path = (file as any).path;
				if (path) openFile(path);
			}
		}
	}

	function handleDragOver(e: DragEvent) {
		e.preventDefault();
	}

	let themePairs = getThemePairs();
</script>

<div
	class="app"
	class:focus-mode={$focusMode}
	class:focus-scroll-active={isFocusScrollActive}
	class:is-light-theme={$currentTheme.name.toLowerCase().includes('light')}
	class:editing-in-focus={isEditingInDarkFocus}
	role="application"
	on:drop={handleDrop}
	on:dragover={handleDragOver}
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
				title="打开文件 (Ctrl+O)"
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
					title="目录 (Ctrl+T)"
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
					title="搜索 (Ctrl+F)"
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
				title="设置 (Ctrl+,)"
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
		{#if $isLoading}
			<div class="loading">
				<div class="loading-dot"></div>
			</div>
		{:else if $renderedHtml}
			<article class="article">
				{@html $renderedHtml}
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
				<p class="welcome-hint">Ctrl+O 或将文件拖到此处</p>
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










