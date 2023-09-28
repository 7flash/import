import * as log from "https://deno.land/std@0.198.0/log/mod.ts";
import type { DenoConfiguration } from 'https://deno.land/x/configuration@0.2.0/mod.ts';
import { dirname } from 'https://deno.land/std@0.198.0/path/mod.ts';
import { resolve, toFileUrl } from 'https://deno.land/std@0.198.0/path/mod.ts';
import {
	ImportMap,
	resolveImportMap,
	resolveModuleSpecifier,
} from 'https://deno.land/x/importmap@0.2.1/mod.ts';
import * as nativeEsbuild from 'https://deno.land/x/esbuild@v0.19.1/mod.js';
import * as webAssemblyEsbuild from 'https://deno.land/x/esbuild@v0.19.1/wasm.js';
import { denoPlugins } from 'https://deno.land/x/esbuild_deno_loader@0.8.1/mod.ts';

await log.setup({
	handlers: {
		console: new log.handlers.ConsoleHandler("DEBUG"),
	},
	loggers: {
		default: {
			level: "DEBUG",
			handlers: ["console"],
		},
	},
});

interface CallSite {
	getFileName(): string;
}

declare global {
	interface ErrorConstructor {
		stackTraceLimit: number;
		prepareStackTrace(error: Error, callSites: CallSite[]): unknown;
	}
}

export interface DynamicImportOptions {
	force?: boolean;
}

export interface ImportStringOptions {
	base?: URL;
	parameters?: Record<string, unknown>;
}

const SHEBANG = /^#!.*/;

const isDenoDeploy = Deno.osRelease() === '0.0.0-00000000-generic';
const isDenoCLI = !isDenoDeploy;
const isDenoCompiled = dirname(Deno.execPath()) === Deno.cwd();

let configuration: DenoConfiguration | null = null;
let configurationPath: string | null = null;

log.debug("Checking for Deno configurations...");

for (const filename of ['deno.json', 'deno.jsonc'] as const) {
	try {
		configuration = JSON.parse(
			await Deno.readTextFile(filename),
		) as DenoConfiguration;

		configurationPath = resolve(filename);
		break;
	} catch (error) {
		if (error instanceof Deno.errors.NotFound) continue;
		log.error(`Error reading configuration: ${error.message}`);
		throw error;
	}
}

let importMap: ImportMap | null = null;
const { imports, scopes, importMap: importMapFilepath } = configuration ?? {};

if (imports || scopes) importMap = { imports, scopes };

const importMapUrl = importMapFilepath
	? toFileUrl(resolve(importMapFilepath))
	: null;

if (importMapFilepath) {
	importMap = resolveImportMap(
		JSON.parse(
			await Deno.readTextFile(importMapFilepath),
		),
		importMapUrl!,
	);
}

const esbuild: typeof webAssemblyEsbuild = isDenoCLI
	? nativeEsbuild
	: webAssemblyEsbuild;

let esbuildInitialized = false;

const esbuildOptions: webAssemblyEsbuild.BuildOptions = {
	bundle: true,
	platform: 'neutral',
	tsconfig: configurationPath ?? undefined,
	format: 'esm',
	write: false,
	ignoreAnnotations: true,
	keepNames: true,
	treeShaking: false,
	logLevel: 'error',
	plugins: denoPlugins({
		configPath: configurationPath ?? undefined,
		importMapURL: configurationPath
			? undefined
			: (importMapUrl?.href ?? undefined),
		loader: 'portable',
	}),
};

const AsyncFunction = async function() { }.constructor;

function customPrepareStackTrace(_error: Error, callSites: CallSite[]) {
	// Retrieve the file name from the third call site
	// (0: this function, 1: Error constructor, 2: our caller)
	return callSites[2] && callSites[2].getFileName();
}

function getCallerUrl() {
	const originalPrepareStackTrace = Error.prepareStackTrace;
	Error.prepareStackTrace = customPrepareStackTrace;

	const callerFile = new Error().stack;

	Error.prepareStackTrace = originalPrepareStackTrace;

	if (!callerFile) {
		log.error("Unable to determine the caller's URL. Defaulting to the current script.");
		return new URL(import.meta.url);
	}

	log.debug(`Caller URL determined as: ${callerFile}`);
	return new URL(callerFile);
}

async function buildAndEvaluate(
	options: webAssemblyEsbuild.BuildOptions,
	filepath: string,
	modules: Record<string, unknown> = {},
) {
	log.info(`Building and evaluating for: ${filepath}`);

	if (!isDenoCLI && !esbuildInitialized) {
		esbuild.initialize({
			worker: typeof Worker !== 'undefined',
		});
		esbuildInitialized = true;
		log.debug("Esbuild initialized.");
	}

	const buildResult = await esbuild.build(
		Object.assign({}, esbuildOptions, options),
	);
	log.debug("Esbuild build completed.");

	if (isDenoCLI) {
		esbuild.stop();
		log.debug("Stopped esbuild for Deno CLI.");
	}

	const { text } = buildResult.outputFiles![0];
	const [before, after = '}'] = text.split('export {');
	const body = before.replace(SHEBANG, '')
		.replaceAll(
			'import.meta',
			`{
        main: false,
        url: '${filepath}',
        resolve(specifier) {
          return new URL(specifier, this.url).href
        }
      }`
		) +
		'return {' +
		after.replaceAll(
			/(?<local>\w+) as (?<exported>\w+)/g,
			'$<exported>: $<local>',
		);

	const exports = await AsyncFunction(...Object.keys(modules), body)(
		...Object.values(modules),
	);

	const toStringTaggedExports = Object.assign({
		[Symbol.toStringTag]: 'Module',
	}, exports);

	const sortedExports = Object.fromEntries(
		Object.keys(toStringTaggedExports)
			.sort()
			.map((key) => [key, toStringTaggedExports[key]]),
	);

	const prototypedExports = Object.assign(Object.create(null), sortedExports);
	const sealedExports = Object.seal(prototypedExports);

	log.info("Build and evaluation finished.");
	return sealedExports;
}

export async function dynamicImport(
	moduleName: string,
	{ force = false }: DynamicImportOptions = {},
) {
	log.info(`Dynamic importing module: ${moduleName}`);

	try {
		if (force) {
			log.error("Force option enabled.");
			throw new Error('Forced');
		}

		log.debug(`Importing module: ${moduleName}`);
		return await import(moduleName);
	} catch (error) {
		log.error(`Error during dynamic import: ${error.message}`);

		if (!isDenoCompiled && !isDenoDeploy && error.message !== 'Forced') {
			throw error;
		}

		log.debug("Resolving module using custom logic...");
		const base = getCallerUrl();
		log.debug("base " + base);
		const filename = resolveModuleSpecifier(moduleName, importMap ?? {}, base);
		log.debug(`Resolved filename: ${filename}`);

		return await buildAndEvaluate({ entryPoints: [filename] }, filename);
	}
}

export async function importString(
	moduleString: string,
	{
		base = getCallerUrl(),
		parameters = {},
	}: ImportStringOptions = {},
) {
	log.info("Importing string...");

	log.debug(`Base URL for importing string: ${base}`);
	log.debug(`Parameters: ${JSON.stringify(parameters)}`);

	return await buildAndEvaluate(
		{
			stdin: {
				contents: moduleString,
				loader: 'tsx',
				sourcefile: base.href,
			},
		},
		base.href,
		parameters,
	);
}
