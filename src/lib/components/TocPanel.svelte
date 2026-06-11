<script lang="ts">
	import { tocOpen } from "$lib/stores/app";
	import type { TocItem } from "$lib/render/markdown";

	export let items: TocItem[] = [];
	export let onJump: (id: string) => void;
</script>

{#if $tocOpen && items.length > 0}
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
			{#each items as item}
				<button
					class="toc-item toc-level-{item.level}"
					on:click={() => onJump(item.id)}
				>
					{item.text}
				</button>
			{/each}
		</div>
	</div>
{/if}

<style>
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

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes slideIn {
		from { transform: translateX(20px); opacity: 0; }
		to { transform: translateX(0); opacity: 1; }
	}
</style>
