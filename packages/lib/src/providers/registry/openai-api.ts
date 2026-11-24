import { createOpenAI, openai } from "@ai-sdk/openai";
import { generateText, type InferToolOutput } from "ai";
import { getCredential } from "../../secrets";
import {
	API_PROVIDER_MAX_OUTPUT_TOKENS,
	configuredWhen,
	OPENAI_WEB_SEARCH_CONTEXT_SIZE,
	OPENAI_WEB_SEARCH_MAX_TOOL_CALLS,
	RESEARCH_WEB_SEARCH_CONTEXT_SIZE,
	RESEARCH_WEB_SEARCH_MAX_USES,
	reportedWebQueries,
	warnIfOutputCapped,
} from "../config";
import type {
	Provider,
	ProviderOptions,
	ScrapeResult,
	StructuredResearchOptions,
	StructuredResearchResult,
} from "../types";
import { structuredResearch } from "./ai-sdk";
import { nonEmptyStrings } from "./scrape-shared";

const DEFAULT_RESEARCH_MODEL = "gpt-6-luna";

type WebSearchOutput = InferToolOutput<ReturnType<typeof openai.tools.webSearch>>;

/**
 * The query comes back on the tool result, not the call, whose input is empty.
 * `output` is `unknown` because `tools` is conditional, so callers match `toolName`
 * first; the SDK's shape still catches a renamed field.
 */
function webSearchQueries(output: unknown): string[] {
	const action = (output as WebSearchOutput).action;
	if (action?.type !== "search") return [];
	return nonEmptyStrings([action.query, ...(action.queries ?? [])]);
}

function isResponsesPayload(body: unknown): body is { output: unknown[] } {
	return Array.isArray((body as { output?: unknown } | null | undefined)?.output);
}

function rebuildRawOutput(result: { text: string; sources: readonly { sourceType: string }[] }) {
	const annotations = result.sources
		.filter((source): source is typeof source & { url: string; title?: string } => source.sourceType === "url")
		.map((source) => ({ type: "url_citation", url: source.url, title: source.title }));
	return {
		output: [{ type: "message", content: [{ type: "output_text", text: result.text, annotations }] }],
	};
}

async function runResponses(
	providerId: string,
	model: ReturnType<typeof openai.responses>,
	version: string,
	prompt: string,
	options?: ProviderOptions,
): Promise<ScrapeResult> {
	const webSearch = options?.webSearch === true;

	const result = await generateText({
		model,
		prompt,
		maxOutputTokens: API_PROVIDER_MAX_OUTPUT_TOKENS["openai-api"],
		toolChoice: webSearch ? "auto" : "none",
		...(webSearch
			? {
					tools: { web_search: openai.tools.webSearch({ searchContextSize: OPENAI_WEB_SEARCH_CONTEXT_SIZE }) },
					providerOptions: { openai: { maxToolCalls: OPENAI_WEB_SEARCH_MAX_TOOL_CALLS } },
				}
			: {}),
	});

	warnIfOutputCapped(providerId, version, result.finishReason);

	// The payload's web_search_call items are the only record of what the model
	// searched; the rebuilt fallback carries the answer and citations but none.
	const body = result.response?.body;
	const rawOutput = isResponsesPayload(body) ? body : rebuildRawOutput(result);

	const webQueries = result.content.flatMap((part) =>
		part.type === "tool-result" && part.toolName === "web_search" ? webSearchQueries(part.output) : [],
	);

	return {
		rawOutput,
		webQueries: reportedWebQueries(webQueries, { webSearch: options?.webSearch ?? false }),
		modelVersion: version,
	};
}

function responsesProvider(id: string, name: string, credential: string, baseURL?: string): Provider {
	function responsesModel(version: string) {
		const apiKey = getCredential(credential);
		if (baseURL && !apiKey) throw new Error(`${credential} is required for ${name}`);
		const provider = apiKey ? createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) }) : openai;
		return provider.responses(version);
	}

	return {
		id,
		name,
		access: "api",
		docsAnchor: "direct-model-apis",
		isConfigured: configuredWhen(credential),

		async run(_model: string, prompt: string, options?: ProviderOptions): Promise<ScrapeResult> {
			const version = options?.version ?? DEFAULT_RESEARCH_MODEL;
			return runResponses(id, responsesModel(version), version, prompt, options);
		},

		async runStructuredResearch<T>({
			prompt,
			schema,
			webSearch = true,
		}: StructuredResearchOptions<T>): Promise<StructuredResearchResult<T>> {
			const object = await structuredResearch(responsesModel(DEFAULT_RESEARCH_MODEL), {
				prompt,
				schema,
				...(webSearch
					? {
							tools: {
								web_search: openai.tools.webSearch({ searchContextSize: RESEARCH_WEB_SEARCH_CONTEXT_SIZE }),
							},
							providerOptions: { openai: { maxToolCalls: RESEARCH_WEB_SEARCH_MAX_USES } },
						}
					: {}),
			});
			return { object, modelVersion: DEFAULT_RESEARCH_MODEL };
		},
	};
}

export const openaiApi = responsesProvider("openai-api", "OpenAI API", "OPENAI_API_KEY");
export const rampRouter = responsesProvider(
	"ramp-router",
	"Ramp Router",
	"RAMP_ROUTER_API_KEY",
	"https://api.router.com/v1",
);
