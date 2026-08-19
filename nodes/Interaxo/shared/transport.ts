import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IPollFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

export type InteraxoContext =
	| IExecuteFunctions
	| IHookFunctions
	| ILoadOptionsFunctions
	| IPollFunctions;

const CREDENTIAL_TYPE = 'interaxoApi';

// Production page size used by the ifcpipeline workflows; children/search take
// limit+skip and return a bare JSON array with no total count or cursor.
export const DEFAULT_PAGE_SIZE = 500;

export interface InteraxoRequestExtras {
	qs?: IDataObject;
	body?: IDataObject | unknown;
	host?: 'api' | 'ix';
	option?: Partial<IHttpRequestOptions>;
}

function errorStatus(error: unknown): number | undefined {
	const e = error as {
		httpCode?: string | number;
		statusCode?: number;
		response?: { status?: number };
		cause?: { response?: { status?: number } };
	};
	const raw = e.httpCode ?? e.statusCode ?? e.response?.status ?? e.cause?.response?.status;
	return raw === undefined ? undefined : Number(raw);
}

export async function interaxoRequest(
	this: InteraxoContext,
	method: IHttpRequestMethods,
	path: string,
	extras: InteraxoRequestExtras = {},
) {
	const credentials = await this.getCredentials(CREDENTIAL_TYPE);
	const base = ((extras.host === 'ix' ? credentials.ixUrl : credentials.apiUrl) as string).replace(
		/\/+$/,
		'',
	);

	const options: IHttpRequestOptions = {
		method,
		url: `${base}${path}`,
		qs: extras.qs,
		body: extras.body as IDataObject,
		json: true,
		...extras.option,
	};
	if (options.body === undefined) delete options.body;

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_TYPE, options);
	} catch (error) {
		// n8n's default messages ("Bad request - please check your parameters")
		// hide Interaxo's error body ({code, message, trace_id, field errors}) —
		// dig it out of the wrapped axios error and surface it
		let body: IDataObject | undefined;
		let cursor = error as
			| { response?: { body?: unknown; data?: unknown }; cause?: unknown }
			| undefined;
		for (let depth = 0; cursor && depth < 5 && !body; depth++) {
			const candidate = cursor.response?.body ?? cursor.response?.data;
			if (candidate && typeof candidate === 'object') body = candidate as IDataObject;
			cursor = cursor.cause as typeof cursor;
		}
		if (body && typeof body === 'object' && (body.message || body.code || body.errors)) {
			const detail = [body.code, body.message].filter(Boolean).join(': ');
			const fieldErrors = body.errors ? ` — ${JSON.stringify(body.errors)}` : '';
			throw new NodeApiError(this.getNode(), error as JsonObject, {
				message: `${detail || 'Interaxo API error'}${fieldErrors}`,
				description: `${method} ${path}`,
			});
		}
		throw error instanceof NodeApiError
			? error
			: new NodeApiError(this.getNode(), error as JsonObject);
	}
}

export interface InteraxoPagedOptions {
	qs?: IDataObject;
	pageSize?: number;
	maxItems?: number;
	/** A 404 from /search below an empty folder means "no results", not an error */
	treat404AsEmpty?: boolean;
	host?: 'api' | 'ix';
}

export async function interaxoRequestPaged(
	this: InteraxoContext,
	path: string,
	{ qs = {}, pageSize = DEFAULT_PAGE_SIZE, maxItems, treat404AsEmpty = false, host }: InteraxoPagedOptions = {},
): Promise<IDataObject[]> {
	const results: IDataObject[] = [];
	let skip = 0;

	for (;;) {
		const limit =
			maxItems === undefined ? pageSize : Math.min(pageSize, Math.max(1, maxItems - results.length));
		let page: unknown;
		try {
			page = await interaxoRequest.call(this, 'GET', path, { qs: { ...qs, limit, skip }, host });
		} catch (error) {
			if (treat404AsEmpty && errorStatus(error) === 404) return results;
			throw error instanceof NodeApiError
				? error
				: new NodeApiError(this.getNode(), error as JsonObject);
		}
		if (!Array.isArray(page)) break;
		results.push(...(page as IDataObject[]));
		if (page.length < limit) break;
		if (maxItems !== undefined && results.length >= maxItems) break;
		skip += page.length;
	}

	return maxItems === undefined ? results : results.slice(0, maxItems);
}

export function roomPath(community: string, room: string): string {
	return `/v1/${encodeURIComponent(community)}/rooms/${encodeURIComponent(room)}`;
}

export function getRlc(ctx: IExecuteFunctions, name: string, i: number): string {
	return ctx.getNodeParameter(name, i, undefined, { extractValue: true }) as string;
}

/**
 * Search results point at files whose parent is an entry — not something you can
 * post new entries into. Walk parent_id upward until an active-folder or
 * workflow-folder is reached (bounded, cycle-detected; mirrors
 * interaxo_service._resolve_entry_post_target_folder_id).
 */
export async function resolvePostableFolder(
	this: InteraxoContext,
	community: string,
	room: string,
	startId: string,
): Promise<IDataObject | undefined> {
	const seen = new Set<string>();
	let currentId: string | undefined = startId;

	for (let hop = 0; hop < 48 && currentId && !seen.has(currentId); hop++) {
		seen.add(currentId);
		const item = (await interaxoRequest.call(
			this,
			'GET',
			`${roomPath(community, room)}/content/${encodeURIComponent(currentId)}`,
		)) as IDataObject;
		if (item.type === 'active-folder' || item.type === 'workflow-folder') return item;
		currentId = item.parent_id as string | undefined;
	}

	return undefined;
}

// Node 18+ ships WHATWG FormData/Blob globally (undici); the tsconfig lib set
// predates them, so declare the minimal surface we use.
declare const FormData: {
	new (): { append(name: string, value: unknown, fileName?: string): void };
};
declare const Blob: { new (parts: unknown[], options?: { type?: string }): unknown };

/**
 * Multipart upload; used both for new attachments (POST .../content/{entry}/children)
 * and new versions (POST .../files/{id}/versions). Field name must be `file`.
 */
export async function interaxoUploadFile(
	this: InteraxoContext,
	path: string,
	buffer: Buffer,
	fileName: string,
	mimeType?: string,
): Promise<IDataObject> {
	const form = new FormData();
	form.append('file', new Blob([buffer], mimeType ? { type: mimeType } : undefined), fileName);

	const response = await interaxoRequest.call(this, 'POST', path, {
		body: form,
		option: {
			json: false,
			headers: { Accept: 'application/json' },
			timeout: 300_000,
		},
	});

	if (typeof response === 'string' && response.length > 0) {
		try {
			return JSON.parse(response) as IDataObject;
		} catch {
			return { raw: response };
		}
	}
	return (response ?? {}) as IDataObject;
}
