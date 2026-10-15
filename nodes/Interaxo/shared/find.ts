import type { IDataObject, INodeProperties, JsonObject } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import type { InteraxoContext } from './transport';
import { interaxoRequest, interaxoRequestPaged, roomPath } from './transport';

const ENTRY_FOLDER_TYPES = ['active-folder', 'workflow-folder'];

/* ------------------------------------------------------------------ name matching */

export interface NameMatcher {
	(name: unknown): boolean;
	/** The pattern is a literal name (no wildcards) */
	exact: boolean;
	pattern: string;
}

/**
 * Exact name or glob (`*`, `?`). Interaxo's own `name=` query parameter is a
 * case-insensitive *prefix* match (observed) — `name=ABC-0001` also returns
 * `ABC-0001_Part2` — so every result has to be re-checked client-side.
 */
export function nameMatcher(pattern: string, caseSensitive = false): NameMatcher {
	const trimmed = pattern.trim();
	const exact = !/[*?]/.test(trimmed);
	const flags = caseSensitive ? '' : 'i';
	const source = trimmed
		.split('')
		.map((ch) => {
			if (ch === '*') return '.*';
			if (ch === '?') return '.';
			return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
		})
		.join('');
	const regex = new RegExp(`^${source}$`, flags);
	const matcher = ((name: unknown) =>
		trimmed === '' || (typeof name === 'string' && regex.test(name))) as NameMatcher;
	matcher.exact = exact;
	matcher.pattern = trimmed;
	return matcher;
}

/**
 * Server-side `name=` pre-filter. The API understands `*` globs (production searches
 * `*.rvt`) and otherwise matches by prefix, so literal names and `*` patterns are
 * passed through as-is; for `?` patterns only the literal prefix is sent. Results are
 * always re-checked client-side.
 */
function serverNameFilter(pattern: string): string | undefined {
	if (!pattern) return undefined;
	if (!pattern.includes('?')) return pattern;
	const prefix = pattern.split(/[*?]/)[0];
	return prefix.length > 0 ? prefix : undefined;
}

/* ------------------------------------------------------------------ room / root */

function statusOf(error: unknown): number | undefined {
	const e = error as { httpCode?: string | number; response?: { status?: number } };
	const raw = e.httpCode ?? e.response?.status;
	return raw === undefined ? undefined : Number(raw);
}

// Room lists change rarely (rooms are created by admins), and callers that pass the
// root UUID would otherwise pay a 404 plus a list request on every item. Cache per
// community for a few minutes, per n8n process.
const ROOM_LIST_TTL_MS = 10 * 60 * 1000;
const roomListCache = new Map<string, { at: number; rooms: IDataObject[] }>();

async function listRoomsCached(this: InteraxoContext, community: string): Promise<IDataObject[]> {
	const hit = roomListCache.get(community);
	if (hit && Date.now() - hit.at < ROOM_LIST_TTL_MS) return hit.rooms;
	const rooms = (await interaxoRequest.call(
		this,
		'GET',
		`/v1/${encodeURIComponent(community)}/rooms`,
	)) as IDataObject[];
	const list = Array.isArray(rooms) ? rooms : [];
	roomListCache.set(community, { at: Date.now(), rooms: list });
	return list;
}

function isUuid(value: string): boolean {
	return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * GET a room by slug, content-root UUID or display name. Content paths accept the
 * root UUID in the {room} position, but `GET /rooms/{room}` itself only accepts the
 * slug (observed: 404 for the UUID), so fall back to matching the room list.
 */
export async function getRoom(
	this: InteraxoContext,
	community: string,
	room: string,
): Promise<IDataObject> {
	if (isUuid(room)) {
		const known = roomListCache.get(community)?.rooms.find(
			(r) => (r.content as IDataObject | undefined)?.root_id === room,
		);
		if (known) return known;
	}
	try {
		return (await interaxoRequest.call(this, 'GET', roomPath(community, room))) as IDataObject;
	} catch (error) {
		if (statusOf(error) !== 404) {
			throw error instanceof NodeApiError
				? error
				: new NodeApiError(this.getNode(), error as JsonObject);
		}
	}
	const list = await listRoomsCached.call(this, community);
	const rootOf = (r: IDataObject) => (r.content as IDataObject | undefined)?.root_id;
	const match =
		list.find((r) => r.id === room || rootOf(r) === room) ?? list.find((r) => r.name === room);
	if (!match) {
		throw new NodeOperationError(
			this.getNode(),
			`Room "${room}" not found in community "${community}" — use the room slug, its content root ID or its name`,
		);
	}
	return match;
}

export async function getRoomRootId(
	this: InteraxoContext,
	community: string,
	room: string,
): Promise<string> {
	const roomInfo = await getRoom.call(this, community, room);
	const rootId = (roomInfo.content as IDataObject | undefined)?.root_id as string | undefined;
	if (!rootId) {
		throw new NodeOperationError(
			this.getNode(),
			`Could not resolve the content root of room "${room}"`,
		);
	}
	return rootId;
}

/* ------------------------------------------------------------------ path resolution */

export interface ResolvedPath {
	/** The item the path points at (folder, entry or file) */
	item: IDataObject;
	/** Workflow step named in the path, when the path ends at a step of a workflow-folder */
	step: IDataObject | null;
}

function splitPath(path: string): string[] {
	return path
		.split('/')
		.map((segment) => segment.trim())
		.filter(Boolean);
}

function pickByName(
	candidates: IDataObject[],
	segment: string,
	describe: () => string,
	ctx: InteraxoContext,
): IDataObject {
	// exact first, then case-insensitive — but never guess between several
	const exact = candidates.filter((c) => c.name === segment);
	if (exact.length === 1) return exact[0];
	const lower = segment.toLowerCase();
	const loose = exact.length
		? exact
		: candidates.filter((c) => typeof c.name === 'string' && c.name.toLowerCase() === lower);
	if (loose.length === 1) return loose[0];
	if (loose.length > 1) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Path segment "${segment}" is ambiguous: ${loose.length} items share that name in ${describe()}`,
		);
	}
	const available = candidates
		.slice(0, 50)
		.map((c) => `${c.name as string} (${c.type as string})`)
		.join(', ');
	throw new NodeOperationError(
		ctx.getNode(),
		`Path segment "${segment}" not found in ${describe()}. Available: ${available || 'none'}`,
	);
}

/**
 * Resolve a slash-separated path of display names, the same shape as an item's
 * `path` property: `/Folder/Sub/Workflow folder/Step/Entry/file.pdf`.
 *
 * - Folders are matched against the children of the previous segment.
 * - Below a workflow-folder the next segment may name a workflow **step**; a path
 *   that ends there resolves to the folder plus that step.
 * - Entries are looked up with one server-side search (prefix match) and then
 *   matched exactly, honouring the step when one was given.
 */
export async function resolvePath(
	this: InteraxoContext,
	community: string,
	room: string,
	path: string,
	startId?: string,
): Promise<ResolvedPath> {
	const base = roomPath(community, room);
	const segments = splitPath(path);
	const rootId = startId || (await getRoomRootId.call(this, community, room));

	let current = (await interaxoRequest.call(
		this,
		'GET',
		`${base}/content/${encodeURIComponent(rootId)}`,
	)) as IDataObject;
	let step: IDataObject | null = null;
	const walked: string[] = [];

	for (let index = 0; index < segments.length; index++) {
		const segment = segments[index];
		const where = () => `"/${walked.join('/')}"`;
		const type = current.type as string;

		if (ENTRY_FOLDER_TYPES.includes(type) && !step) {
			// workflow step segment?
			const steps = (current.steps ?? []) as IDataObject[];
			const stepMatch = steps.find(
				(s) => typeof s.name === 'string' && s.name.toLowerCase() === segment.toLowerCase(),
			);
			if (stepMatch) {
				step = stepMatch;
				walked.push(segment);
				continue;
			}
		}

		if (ENTRY_FOLDER_TYPES.includes(type)) {
			// entry segment: children of an entry-holding folder can number in the
			// thousands, so ask the search index instead of listing them all
			const folderId = current.id as string;
			const prefix = serverNameFilter(segment);
			let candidates = await interaxoRequestPaged.call(
				this,
				`${base}/content/${encodeURIComponent(folderId)}/search`,
				{ qs: { type: 'entry', ...(prefix ? { name: prefix } : {}) }, treat404AsEmpty: true },
			);
			// search is recursive; keep direct children only
			candidates = candidates.filter((c) => c.parent_id === folderId);
			if (step) {
				const stepId = step.id;
				candidates = candidates.filter((c) => (c.step as IDataObject | undefined)?.id === stepId);
			}
			const stepNames = ((current.steps ?? []) as IDataObject[]).map((s) => s.name as string);
			const describe =
				step || stepNames.length === 0
					? where
					: () => `${where()} (no entry by that name; workflow steps: ${stepNames.join(', ')})`;
			current = pickByName(candidates, segment, describe, this);
			walked.push(segment);
			continue;
		}

		// simple-folder, room root, or entry (whose children are its file attachments)
		const children = await interaxoRequestPaged.call(
			this,
			`${base}/content/${encodeURIComponent(current.id as string)}/children`,
		);
		current = pickByName(children, segment, where, this);
		walked.push(segment);
		if (current.type === 'file' && index < segments.length - 1) {
			throw new NodeOperationError(
				this.getNode(),
				`Path continues below file "${segment}" — files have no children`,
			);
		}
		// the next segment depends on steps; fetch the full item if a listing ever
		// comes back without them
		if (ENTRY_FOLDER_TYPES.includes(current.type as string) && current.steps === undefined) {
			current = (await interaxoRequest.call(
				this,
				'GET',
				`${base}/content/${encodeURIComponent(current.id as string)}`,
			)) as IDataObject;
		}
	}

	return { item: current, step };
}

/* ------------------------------------------------------------------ folder locator */

/**
 * Resource locator for "where to look": empty = the room's content root, a UUID,
 * or a path of display names.
 */
export function folderLocator(
	name: string,
	displayName: string,
	description: string,
	displayOptions: INodeProperties['displayOptions'],
): INodeProperties {
	return {
		displayName,
		name,
		type: 'resourceLocator',
		default: { mode: 'path', value: '' },
		description,
		displayOptions,
		modes: [
			{
				displayName: 'By Path',
				name: 'path',
				type: 'string',
				placeholder: 'e.g. /Projects/Design/Architecture/In Progress',
			},
			{
				displayName: 'By ID',
				name: 'id',
				type: 'string',
				placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
			},
		],
	};
}

export interface ResolvedLocation {
	id: string;
	type: string;
	path: string | null;
	parent_id: string | null;
	/** Step named by the path (workflow-folder/Step) — restricts results to that step */
	step: IDataObject | null;
}

export async function resolveLocation(
	this: InteraxoContext,
	community: string,
	room: string,
	locator: { mode?: string; value?: string } | string | undefined,
): Promise<ResolvedLocation> {
	const mode = typeof locator === 'object' && locator ? locator.mode : 'id';
	const value = String((typeof locator === 'object' && locator ? locator.value : locator) ?? '').trim();
	const base = roomPath(community, room);

	if (mode === 'path') {
		const resolved = await resolvePath.call(this, community, room, value);
		return {
			id: resolved.item.id as string,
			type: resolved.item.type as string,
			path: (resolved.item.path as string | undefined) ?? null,
			parent_id: (resolved.item.parent_id as string | undefined) ?? null,
			step: resolved.step,
		};
	}

	const id = value || (await getRoomRootId.call(this, community, room));
	const item = (await interaxoRequest.call(
		this,
		'GET',
		`${base}/content/${encodeURIComponent(id)}`,
	)) as IDataObject;
	return {
		id,
		type: item.type as string,
		path: (item.path as string | undefined) ?? null,
		parent_id: (item.parent_id as string | undefined) ?? null,
		step: null,
	};
}

/* ------------------------------------------------------------------ file finder */

export interface FindFilesOptions {
	/** Exact file name or glob; empty = any */
	fileName?: string;
	caseSensitive?: boolean;
	/** Only files whose entry is in this workflow step (by name, case-insensitive) */
	stepName?: string;
	/** Only files attached to entries with this name (exact or glob) */
	entryName?: string;
	/** Only files modified after this instant */
	modifiedAfter?: Date;
	/** Attach entry_id / entry_name / entry_step (and entry_fields) to every file */
	includeEntry?: boolean;
	includeEntryFields?: boolean;
}

export function flattenFields(fields: unknown): IDataObject {
	const out: IDataObject = {};
	if (!Array.isArray(fields)) return out;
	for (const field of fields as IDataObject[]) {
		const key = (field.name as string | undefined) ?? (field.id as string | undefined);
		if (!key) continue;
		// the API has been seen returning both "value" and the misspelt "value:" key
		out[key] = (field.value ?? field['value:'] ?? null) as IDataObject[keyof IDataObject];
	}
	return out;
}

/**
 * All files below a location, filtered by name / step / entry / modification time.
 *
 * One recursive `/search?type=file` call (paged) covers plain folders and
 * entry-holding folders alike — verified to return exactly the same set as walking
 * entries and listing their attachments, at a fraction of the requests. Entry data
 * (step, name, fields) is fetched with one more `/search?type=entry` only when a
 * filter or the output needs it.
 */
export async function findFiles(
	this: InteraxoContext,
	community: string,
	room: string,
	location: ResolvedLocation,
	options: FindFilesOptions,
): Promise<IDataObject[]> {
	const base = roomPath(community, room);
	const fileMatch = nameMatcher(options.fileName ?? '', options.caseSensitive);
	const entryMatch = nameMatcher(options.entryName ?? '', options.caseSensitive);
	const stepName = (options.stepName || (location.step?.name as string | undefined) || '').trim();

	// a location that *is* an entry or a file needs no search
	if (location.type === 'file') {
		const file = (await interaxoRequest.call(
			this,
			'GET',
			`${base}/content/${encodeURIComponent(location.id)}`,
		)) as IDataObject;
		return (await decorate.call(this, [file], base, options, stepName, entryMatch, fileMatch))
			.files;
	}

	let files: IDataObject[];
	if (location.type === 'entry') {
		files = (
			await interaxoRequestPaged.call(
				this,
				`${base}/content/${encodeURIComponent(location.id)}/children`,
			)
		).filter((child) => child.type === 'file');
	} else {
		const prefix = serverNameFilter(fileMatch.pattern);
		files = await interaxoRequestPaged.call(
			this,
			`${base}/content/${encodeURIComponent(location.id)}/search`,
			{ qs: { type: 'file', ...(prefix ? { name: prefix } : {}) }, treat404AsEmpty: true },
		);
	}

	files = files.filter((file) => fileMatch(file.name));
	if (options.modifiedAfter) {
		const after = options.modifiedAfter.getTime();
		files = files.filter((file) => Date.parse(file.last_modified as string) > after);
	}

	const searchRoot = location.type === 'entry' ? undefined : location.id;
	return (
		await decorate.call(this, files, base, options, stepName, entryMatch, fileMatch, searchRoot)
	).files;
}

async function decorate(
	this: InteraxoContext,
	files: IDataObject[],
	base: string,
	options: FindFilesOptions,
	stepName: string,
	entryMatch: NameMatcher,
	fileMatch: NameMatcher,
	searchRoot?: string,
): Promise<{ files: IDataObject[] }> {
	files = files.filter((file) => fileMatch(file.name));
	const needEntries =
		options.includeEntry || options.includeEntryFields || !!stepName || !!entryMatch.pattern;
	if (!needEntries || files.length === 0) return { files };

	const entries = new Map<string, IDataObject>();
	const parentIds = [...new Set(files.map((file) => file.parent_id as string).filter(Boolean))];

	if (searchRoot && parentIds.length > 20) {
		// many entries: one paged search is cheaper than a GET per entry
		const found = await interaxoRequestPaged.call(
			this,
			`${base}/content/${encodeURIComponent(searchRoot)}/search`,
			{ qs: { type: 'entry' }, treat404AsEmpty: true },
		);
		for (const entry of found) entries.set(entry.id as string, entry);
	}
	for (const parentId of parentIds) {
		if (entries.has(parentId)) continue;
		const parent = (await interaxoRequest.call(
			this,
			'GET',
			`${base}/content/${encodeURIComponent(parentId)}`,
		)) as IDataObject;
		entries.set(parentId, parent);
	}

	const wantedStep = stepName.toLowerCase();
	const out: IDataObject[] = [];
	for (const file of files) {
		const parent = entries.get(file.parent_id as string);
		const isEntry = parent?.type === 'entry';
		const step = isEntry ? ((parent.step as IDataObject | undefined) ?? null) : null;

		if (wantedStep && ((step?.name as string | undefined) ?? '').toLowerCase() !== wantedStep) {
			continue;
		}
		if (entryMatch.pattern && !(isEntry && entryMatch(parent.name))) continue;

		const decorated: IDataObject = { ...file };
		if (options.includeEntry || options.includeEntryFields) {
			decorated.entry_id = isEntry ? parent.id : null;
			decorated.entry_name = isEntry ? parent.name : null;
			decorated.entry_step = (step?.name as string | undefined) ?? null;
			decorated.entry_step_id = (step?.id as string | undefined) ?? null;
		}
		if (options.includeEntryFields) {
			decorated.entry_fields = isEntry ? flattenFields(parent.fields) : {};
		}
		out.push(decorated);
	}
	return { files: out };
}
