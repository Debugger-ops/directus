import fs from 'node:fs';
import path from 'node:path';
import { APP_SHARED_DEPS } from '@directus/extensions';
import { generateExtensionsEntrypoint, resolveFsExtensions, resolveModuleExtensions } from '@directus/extensions/node';
import yaml from '@rollup/plugin-yaml';
import { templateCompilerOptions } from '@tresjs/core';
import UnheadVite from '@unhead/addons/vite';
import vue from '@vitejs/plugin-vue';
import { searchForWorkspaceRoot } from 'vite';
import vueDevtools from 'vite-plugin-vue-devtools';
import { defineConfig } from 'vitest/config';

const API_PATH = path.join('..', 'api');

// api/.env is not loaded automatically when running `pnpm --filter app dev`
const apiEnvFile = path.join(API_PATH, '.env');
if (fs.existsSync(apiEnvFile)) process.loadEnvFile(apiEnvFile);

// Mirror the API's getExtensionsPath() resolution so the dev server reads from
// the same location. In remote mode (EXTENSIONS_LOCATION) the API syncs remote
// extensions into TEMP_PATH/extensions at boot, and EXTENSIONS_PATH is ignored.
// The './node_modules/.directus' and './extensions' fallbacks mirror the
// TEMP_PATH and EXTENSIONS_PATH defaults from @directus/env's DEFAULTS
const EXTENSIONS_PATH = process.env.EXTENSIONS_LOCATION
	? path.resolve(API_PATH, process.env.TEMP_PATH ?? './node_modules/.directus', 'extensions')
	: path.resolve(API_PATH, process.env.EXTENSIONS_PATH ?? './extensions');

const extensionsPathExists = fs.existsSync(EXTENSIONS_PATH);

// https://vitejs.dev/config/
export default defineConfig(({ command }) => ({
	css: {
		preprocessorOptions: {
			scss: {
				api: 'modern-compiler',
			},
		},
	},
	plugins: [
		directusExtensions(),
		vue({
			...templateCompilerOptions,
		}),
		UnheadVite(),
		yaml({
			transform(data) {
				return data === null ? {} : undefined;
			},
		}),
		{
			name: 'watch-directus-dependencies',
			configureServer: (server) => {
				server.watcher.options = {
					...server.watcher.options,
					ignored: [/node_modules\/(?!@directus\/).*/, '**/.git/**'],
				};
			},
		},
		vueDevtools(),
	],
	define: {
		__VUE_I18N_LEGACY_API__: false,
	},
	resolve: {
		alias: [{ find: '@', replacement: path.resolve(__dirname, 'src') }],
	},
	// Derived from the actual Vite command rather than NODE_ENV, since NODE_ENV
	// isn't guaranteed to be 'production' for every build invocation (e.g. CI).
	base: command === 'build' ? '' : '/admin',
	server: {
		port: 8080,
		proxy: {
			'^/(?!admin)': {
				target: process.env.API_URL ? process.env.API_URL : 'http://127.0.0.1:8055/',
			},
			'/websocket/logs': {
				target: process.env.API_URL ? process.env.API_URL : 'ws://127.0.0.1:8055/',
				changeOrigin: true,
			},
			'/websocket': {
				target: process.env.API_URL ? process.env.API_URL : 'ws://127.0.0.1:8055/',
				changeOrigin: true,
				ws: true,
			},
		},
		fs: {
			allow: [searchForWorkspaceRoot(process.cwd()), ...getExtensionsRealPaths()],
		},
	},
	test: {
		dir: path.resolve(__dirname, '..'),
		include: ['app/**/*.test.ts'],
		environment: 'happy-dom',
		deps: {
			optimizer: {
				web: {
					exclude: ['pinia', 'url'],
				},
			},
		},
	},
}));

/**
 * Resolve the real (symlink-following) paths of every installed extension
 * folder, so the Vite dev server is allowed to serve files from them.
 * Silently skips entries that can't be stat'd/resolved (e.g. broken
 * symlinks, extensions removed mid-scan) instead of crashing config load.
 */
function getExtensionsRealPaths() {
	if (!extensionsPathExists) return [];

	const realPaths: string[] = [];

	for (const typeDir of fs.readdirSync(EXTENSIONS_PATH)) {
		const extensionTypeDir = path.join(EXTENSIONS_PATH, typeDir);

		let isDirectory: boolean;

		try {
			isDirectory = fs.statSync(extensionTypeDir).isDirectory();
		} catch {
			continue; // stale entry, ignore
		}

		if (!isDirectory) continue;

		for (const dir of fs.readdirSync(extensionTypeDir)) {
			try {
				realPaths.push(fs.realpathSync(path.join(extensionTypeDir, dir)));
			} catch {
				// stale symlink or removed extension, ignore
			}
		}
	}

	return realPaths;
}

function directusExtensions() {
	const virtualExtensionsId = '@directus-extensions';
	let extensionsEntrypoint: string | null = null;

	async function loadExtensions() {
		const localExtensions = extensionsPathExists ? await resolveFsExtensions(EXTENSIONS_PATH) : new Map();
		const moduleExtensions = await resolveModuleExtensions(API_PATH);
		const registryExtensions = extensionsPathExists
			? await resolveFsExtensions(path.join(EXTENSIONS_PATH, '.registry'))
			: new Map();

		// Builds the settings entries for one extension: itself, plus one entry
		// per sub-extension if it's a bundle.
		const toSettings = (source: string) => ([folder, extension]: [string, any]) => {
			const settings = [{ id: extension.name, enabled: true, folder, bundle: null, source }];

			if (extension.type === 'bundle') {
				settings.push(
					...extension.entries.map((entry: { name: string }) => ({
						enabled: true,
						folder: entry.name,
						bundle: extension.name,
						source,
					})),
				);
			}

			return settings;
		};

		// default to enabled for app extension in developer mode
		const extensionSettings = [
			...Array.from(localExtensions.entries()).flatMap(toSettings('local')),
			...Array.from(moduleExtensions.entries()).flatMap(toSettings('module')),
			...Array.from(registryExtensions.entries()).flatMap(toSettings('registry')),
		];

		extensionsEntrypoint = generateExtensionsEntrypoint(
			{ module: moduleExtensions, local: localExtensions, registry: registryExtensions },
			extensionSettings,
		);
	}

	return [
		{
			name: 'directus-extensions-serve',
			apply: 'serve',
			config: () => ({
				optimizeDeps: {
					include: APP_SHARED_DEPS,
				},
			}),
			async buildStart() {
				await loadExtensions();
			},
			resolveId(id: string) {
				if (id === virtualExtensionsId) {
					return id;
				}
			},
			load(id: string) {
				if (id === virtualExtensionsId) {
					return extensionsEntrypoint;
				}
			},
		},
		{
			name: 'directus-extensions-build',
			apply: 'build',
			config: () => ({
				build: {
					rollupOptions: {
						input: {
							index: path.resolve(__dirname, 'index.html'),
							...APP_SHARED_DEPS.reduce((acc, dep) => ({ ...acc, [dep.replace(/\//g, '_')]: dep }), {}),
						},
						output: {
							entryFileNames: 'assets/[name].[hash].entry.js',
						},
						external: [virtualExtensionsId],
						preserveEntrySignatures: 'exports-only',
					},
				},
			}),
		},
	];
}
