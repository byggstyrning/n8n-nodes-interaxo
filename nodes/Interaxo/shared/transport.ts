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
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { randomBytes } from 'crypto';

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
		// NodeApiError keeps the parsed response body in context.data
		const contextData = (error as { context?: { data?: unknown } }).context?.data;
		if (contextData && typeof contextData === 'object') body = contextData as IDataObject;
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
			const errors = Array.isArray(body.errors) ? (body.errors as IDataObject[]) : [];
			const fieldErrors = errors.length
				? ` — ${errors.map((e) => [e.code, e.message].filter(Boolean).join(': ')).join('; ')}`
				: body.errors
					? ` — ${JSON.stringify(body.errors)}`
					: '';
			const status = errorStatus(error);
			const message = `${detail || 'Interaxo API error'}${fieldErrors}`;
			const apiError = new NodeApiError(this.getNode(), error as JsonObject, {
				message,
				description: `${method} ${path}`,
				// keep the status: callers branch on 404
				...(status !== undefined ? { httpCode: String(status) } : {}),
			});
			// NodeApiError swaps in a generic text ("Bad request - please check your
			// parameters") for known status codes; Interaxo's own message is the useful one
			apiError.message = message;
			throw apiError;
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

type BinaryStream = Awaited<ReturnType<IExecuteFunctions['helpers']['getBinaryStream']>>;

type StreamContent = { size: number; open: () => Promise<BinaryStream> };

/** File bytes for interaxoUploadFile: in memory, or re-readable from n8n's binary store */
export type UploadContent = Buffer | StreamContent;

/**
 * The binary property's bytes for an upload. When n8n keeps binary data on disk
 * (N8N_DEFAULT_BINARY_DATA_MODE=filesystem, ids `filesystem-v2:…`) the upload streams
 * from that file, so a 400 MB IFC is never held in memory; in-memory, s3 and database
 * binaries are read into a Buffer as before.
 */
export async function getUploadContent(
	this: IExecuteFunctions,
	i: number,
	binaryPropertyName: string,
): Promise<UploadContent> {
	const { id } = this.helpers.assertBinaryData(i, binaryPropertyName);
	if (id?.startsWith('filesystem')) {
		const { fileSize } = await this.helpers.getBinaryMetadata(id);
		if (Number.isSafeInteger(fileSize) && fileSize >= 0) {
			return { size: fileSize, open: async () => await this.helpers.getBinaryStream(id) };
		}
	}
	return await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
}

// RFC 7578 header/footer around the file bytes, built by hand because the
// community-node lint forbids importing form-data or stream. A Buffer body (binaries
// not on disk) peaks at ~2.3x the file above baseline over plain HTTP and ~3.4x over
// HTTPS, where TLS queues an encrypted copy of the whole body; a streamed body stays
// flat. The earlier WHATWG Blob + FormData version peaked higher still and, on
// Node < 24.20, leaked one full copy of every upload until restart
// (nodejs/node#63574, Blob.prototype.stream()).
function multipartEnvelope(fileName: string, mimeType?: string) {
	const boundary = `----n8nInteraxo${randomBytes(16).toString('hex')}`;
	// Same escaping as the form-data package: quotes and line breaks in the name
	// would otherwise terminate the header.
	const safeName = fileName.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
	return {
		head: Buffer.from(
			`--${boundary}\r\n` +
				`Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
				`Content-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
			'utf8',
		),
		tail: Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

/**
 * head + file + tail as one byte stream. It can be sent once: n8n answers a 401 by
 * refreshing the token and sending the same body object again, and a stream can't be
 * rewound — that resend is failed at once (instead of a request that waits for bytes
 * that never come) and reported by `resent()` so the caller can retry with a new stream.
 */
async function multipartStream(
	this: InteraxoContext,
	content: StreamContent,
	head: Buffer,
	tail: Buffer,
) {
	const node = this.getNode();
	const file = await content.open();
	async function* parts() {
		yield head;
		let bytes = 0;
		for await (const chunk of file as AsyncIterable<Buffer>) {
			bytes += chunk.length;
			if (bytes > content.size) break;
			yield chunk;
		}
		// Content-Length was announced from the metadata: a body that disagrees is cut
		// short, so the request can never complete as a valid upload
		if (bytes !== content.size) {
			throw new NodeOperationError(
				node,
				`Binary data is ${bytes > content.size ? 'larger' : 'smaller'} than its metadata size (${content.size} bytes)`,
			);
		}
		yield tail;
	}
	// fs.ReadStream inherits Readable's static from(); 'stream' itself can't be imported
	const Readable = file.constructor as unknown as {
		from(source: AsyncIterable<Buffer>, options: { objectMode: boolean }): BinaryStream;
	};
	const stream = Readable.from(parts(), { objectMode: false });

	type Request = { destroy(error?: Error): void; writableFinished: boolean };
	let request: Request | undefined;
	let resent = false;
	const pipe = stream.pipe.bind(stream);
	stream.pipe = <T extends NodeJS.WritableStream>(destination: T, options?: { end?: boolean }) => {
		if (!request) {
			request = destination as unknown as Request;
			return pipe(destination, options);
		}
		resent = true;
		(destination as unknown as Request).destroy(new Error('Upload stream was already sent'));
		return destination;
	};
	return {
		stream,
		resent: () => resent,
		// After an error response the request may still be half-sent and the file open
		destroy: () => {
			stream.destroy();
			file.destroy();
			if (request && !request.writableFinished) request.destroy();
		},
	};
}

async function postMultipartStream(
	this: InteraxoContext,
	path: string,
	content: StreamContent,
	envelope: { head: Buffer; tail: Buffer; contentType: string },
): Promise<unknown> {
	const { head, tail, contentType } = envelope;
	for (let attempt = 1; ; attempt++) {
		const body = await multipartStream.call(this, content, head, tail);
		try {
			return await interaxoRequest.call(this, 'POST', path, {
				body: body.stream,
				option: {
					json: false,
					headers: {
						Accept: 'application/json',
						'Content-Type': contentType,
						'Content-Length': String(head.length + content.size + tail.length),
					},
					timeout: 300_000,
					// axios' default transport (follow-redirects) keeps every body chunk until
					// the response, to replay it on a redirect: a full copy of the file
					disableFollowRedirect: true,
				},
			});
		} catch (error) {
			// one retry, with a new stream and the token n8n just refreshed
			if (attempt === 1 && body.resent()) continue;
			throw error instanceof NodeApiError
				? error
				: new NodeApiError(this.getNode(), error as JsonObject);
		} finally {
			body.destroy();
		}
	}
}

/**
 * Multipart upload; used both for new attachments (POST .../content/{entry}/children)
 * and new versions (POST .../files/{id}/versions). Field name must be `file`.
 */
export async function interaxoUploadFile(
	this: InteraxoContext,
	path: string,
	content: UploadContent,
	fileName: string,
	mimeType?: string,
): Promise<IDataObject> {
	const envelope = multipartEnvelope(fileName, mimeType);
	const { head, tail, contentType } = envelope;

	const response = Buffer.isBuffer(content)
		? await interaxoRequest.call(this, 'POST', path, {
				body: Buffer.concat([head, content, tail]),
				option: {
					json: false,
					headers: { Accept: 'application/json', 'Content-Type': contentType },
					timeout: 300_000,
				},
			})
		: await postMultipartStream.call(this, path, content, envelope);

	if (typeof response === 'string' && response.length > 0) {
		try {
			return JSON.parse(response) as IDataObject;
		} catch {
			return { raw: response };
		}
	}
	return (response ?? {}) as IDataObject;
}
