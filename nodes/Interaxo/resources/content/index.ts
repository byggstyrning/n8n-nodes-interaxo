import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { communitySelect, returnAllSelect, roomSelect } from '../../shared/descriptions';
import {
	getRlc,
	interaxoRequest,
	interaxoRequestPaged,
	resolvePostableFolder,
	roomPath,
} from '../../shared/transport';
import { getRoomRootId, nameMatcher, resolvePath } from '../../shared/find';

const showOnlyForContent = {
	resource: ['content'],
};

export const contentDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForContent,
		},
		options: [
			{
				name: 'Delete',
				value: 'delete',
				action: 'Delete a content item',
				description: 'Delete a file, folder or entry permanently',
			},
			{
				name: 'Get',
				value: 'get',
				action: 'Get a content item',
				description: 'Retrieve a single content item of any type',
			},
			{
				name: 'Get by Path',
				value: 'getByPath',
				action: 'Get a content item by path',
				description:
					'Resolve a path of display names (e.g. /Design/Architecture/In Progress/A-40-V-0001/A-40-V-0001.pdf) to the item it points at',
			},
			{
				name: 'List Children',
				value: 'listChildren',
				action: 'List children of a content item',
				description: 'Retrieve a list of direct children of a folder or entry',
			},
			{
				name: 'Resolve Parent Folder',
				value: 'resolveFolder',
				action: 'Resolve the nearest postable parent folder',
				description:
					'Walk parent IDs upward from any item to the nearest active-folder or workflow-folder (the only types entries can be created in)',
			},
			{
				name: 'Search',
				value: 'search',
				action: 'Search below a folder',
				description: 'Recursively search below a folder by type and name (glob supported)',
			},
		],
		default: 'search',
	},
	{
		...communitySelect,
		displayOptions: {
			show: showOnlyForContent,
		},
	},
	{
		...roomSelect,
		displayOptions: {
			show: showOnlyForContent,
		},
	},
	{
		displayName: 'Content ID',
		name: 'contentId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'UUID of the content item',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['delete', 'get', 'listChildren', 'resolveFolder'],
			},
		},
	},
	{
		displayName: 'Path',
		name: 'path',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. /Design/Architecture/In Progress/A-40-V-0001',
		description:
			'Slash-separated display names, as in an item\'s path property. Below a workflow folder a segment may name a workflow step; entries are matched exactly, never by prefix.',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['getByPath'],
			},
		},
	},
	{
		displayName: 'Start Folder ID',
		name: 'startFolderId',
		type: 'string',
		default: '',
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'Resolve the path relative to this folder. Leave empty to start at the room root.',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['getByPath'],
			},
		},
	},
	{
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: false,
		description: 'Whether to return a simplified version of the response instead of the raw data',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['get', 'getByPath', 'listChildren', 'search'],
			},
		},
	},
	{
		displayName: 'Folder ID',
		name: 'folderId',
		type: 'string',
		default: '',
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description:
			'Folder to search below. Leave empty to search from the room content root (content.root_id).',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['search'],
			},
		},
	},
	{
		displayName: 'Type Filter',
		name: 'typeFilter',
		type: 'options',
		// the API's filter value is 'folder' even though plain folders come back
		// typed 'simple-folder'; 'simple-folder' itself is rejected with 404
		options: [
			{ name: 'Active Folder', value: 'active-folder' },
			{ name: 'Any', value: '' },
			{ name: 'Entry', value: 'entry' },
			{ name: 'File', value: 'file' },
			{ name: 'Folder', value: 'folder' },
			{ name: 'Workflow Folder', value: 'workflow-folder' },
		],
		default: '',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['search'],
			},
		},
	},
	{
		displayName: 'Name Filter',
		name: 'nameFilter',
		type: 'string',
		default: '',
		placeholder: 'e.g. *.ifc',
		description:
			'Exact name or glob pattern (* and ?), case-insensitive. Matched exactly: A-40-V-0001 does not also return A-40-V-0001_Part2 (the API itself matches by prefix).',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['search'],
			},
		},
	},
	{
		displayName: 'Step Name Filter',
		name: 'stepNameFilter',
		type: 'string',
		default: '',
		description:
			'Only return entries currently in this workflow step (matched case-insensitively against step.name)',
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['search'],
			},
		},
	},
	...returnAllSelect.map((property) => ({
		...property,
		displayOptions: {
			show: {
				...showOnlyForContent,
				operation: ['listChildren', 'search'],
				...(property.displayOptions?.show ?? {}),
			},
		},
	})),
];

const SIMPLIFIED_KEYS = [
	'id',
	'type',
	'name',
	'path',
	'parent_id',
	'child_count',
	'step',
	'version',
	'file_size',
	'mime_type',
	'content_url',
	'created',
	'last_modified',
];

function simplifyItem(item: IDataObject): IDataObject {
	const out: IDataObject = {};
	for (const key of SIMPLIFIED_KEYS) {
		if (item[key] !== undefined) out[key] = item[key];
	}
	return out;
}

function maybeSimplify(ctx: IExecuteFunctions, i: number, items: IDataObject[]): IDataObject[] {
	return (ctx.getNodeParameter('simplify', i, false) as boolean) ? items.map(simplifyItem) : items;
}

async function resolveSearchRoot(
	ctx: IExecuteFunctions,
	community: string,
	room: string,
	folderId: string,
): Promise<string> {
	return folderId || (await getRoomRootId.call(ctx, community, room));
}

export async function contentGet(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const contentId = this.getNodeParameter('contentId', i) as string;
	const item = (await interaxoRequest.call(
		this,
		'GET',
		`${roomPath(community, room)}/content/${encodeURIComponent(contentId)}`,
	)) as IDataObject;
	return maybeSimplify(this, i, [item])[0];
}

export async function contentGetByPath(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const path = this.getNodeParameter('path', i) as string;
	const startFolderId = this.getNodeParameter('startFolderId', i, '') as string;

	const { item, step } = await resolvePath.call(this, community, room, path, startFolderId);
	const result = maybeSimplify(this, i, [item])[0];
	// a path ending in a workflow step resolves to the folder; say which step
	return step ? { ...result, resolved_step: { id: step.id, name: step.name } } : result;
}

export async function contentDelete(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const contentId = this.getNodeParameter('contentId', i) as string;
	await interaxoRequest.call(
		this,
		'DELETE',
		`${roomPath(community, room)}/content/${encodeURIComponent(contentId)}`,
	);
	return { deleted: true };
}

export async function contentListChildren(
	this: IExecuteFunctions,
	i: number,
): Promise<IDataObject[]> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const contentId = this.getNodeParameter('contentId', i) as string;
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const maxItems = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);

	const children = await interaxoRequestPaged.call(
		this,
		`${roomPath(community, room)}/content/${encodeURIComponent(contentId)}/children`,
		{ maxItems },
	);
	return maybeSimplify(this, i, children);
}

export async function contentSearch(this: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const folderId = this.getNodeParameter('folderId', i, '') as string;
	const typeFilter = this.getNodeParameter('typeFilter', i, '') as string;
	const nameFilter = this.getNodeParameter('nameFilter', i, '') as string;
	const stepNameFilter = this.getNodeParameter('stepNameFilter', i, '') as string;
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const maxItems = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);

	const rootId = await resolveSearchRoot(this, community, room, folderId);

	const qs: IDataObject = {};
	if (typeFilter) qs.type = typeFilter;
	if (nameFilter) qs.name = nameFilter;

	// the API's name= is a case-insensitive prefix match, so names are re-checked
	// client-side; like step filtering, that means the page loop can't be capped
	const matchName = nameMatcher(nameFilter);
	const filterClientSide = !!stepNameFilter || !!nameFilter;
	let results = await interaxoRequestPaged.call(
		this,
		`${roomPath(community, room)}/content/${encodeURIComponent(rootId)}/search`,
		{ qs, maxItems: filterClientSide ? undefined : maxItems, treat404AsEmpty: true },
	);
	if (nameFilter) results = results.filter((item) => matchName(item.name));

	if (stepNameFilter) {
		const needle = stepNameFilter.toLowerCase();
		results = results.filter(
			(item) => ((item.step as IDataObject)?.name as string)?.toLowerCase() === needle,
		);
	}
	if (filterClientSide && maxItems !== undefined) results = results.slice(0, maxItems);

	return maybeSimplify(this, i, results);
}

export async function contentResolveFolder(
	this: IExecuteFunctions,
	i: number,
): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const contentId = this.getNodeParameter('contentId', i) as string;

	const folder = await resolvePostableFolder.call(this, community, room, contentId);
	if (!folder) {
		throw new NodeOperationError(
			this.getNode(),
			`No active-folder or workflow-folder found above content item ${contentId}`,
			{ itemIndex: i },
		);
	}
	return folder;
}

export const contentHandlers = {
	delete: contentDelete,
	get: contentGet,
	getByPath: contentGetByPath,
	listChildren: contentListChildren,
	resolveFolder: contentResolveFolder,
	search: contentSearch,
};
