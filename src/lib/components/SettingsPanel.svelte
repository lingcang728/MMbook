<script lang="ts">
	import { settingsOpen, currentTheme } from "$lib/stores/app";
	import { getThemePairs } from "$lib/theme/themes";

	const themePairs = getThemePairs();
</script>

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
						class:active={$currentTheme.name === pair.light.name}
						on:click={() => ($currentTheme = pair.light)}
					>
						<div
							class="theme-preview"
							style="background: {pair.light.vars['--bg']}; color: {pair.light.vars['--text']}"
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
							style="background: {pair.dark.vars['--bg']}; color: {pair.dark.vars['--text']}"
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

<style>
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

	@keyframes fadeIn {
		from { opacity: 0; }
		to { opacity: 1; }
	}
	@keyframes scaleIn {
		from { transform: scale(0.95); opacity: 0; }
		to { transform: scale(1); opacity: 1; }
	}
</style>
