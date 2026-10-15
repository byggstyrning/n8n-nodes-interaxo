import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { communitySelect, returnAllSelect, roomSelect } from '../../shared/descriptions';
import { findFiles, folderLocator, resolveLocation } from '../../shared/find';
import {
	getRlc,
	interaxoRequest,
	interaxoRequestPaged,
	interaxoUploadFile,
	roomPath,
} from '../../shared/transport';

const showOnlyForFiles = {
	resource: ['file'],
};

export const fileDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForFiles,
		},
		options: [
			{
				name: 'Download',
				value: 'download',
				action: 'Download a file',
				description: 'Download file content via its pre-signed content URL',
			},
			{
				name: 'Find',
				value: 'find',
				action: 'Find files below a folder or path',
				description:
					'Find files below a folder, workflow step or entry by exact name or glob, optionally filtered by workflow step, entry name or modification time',
			},
			{
				name: 'Get Versions',
				value: 'getVersions',
				action: 'Get the version history of a file',
				description: 'Retrieve the version history including uploader identities',
			},
			{
				name: 'Revert Version',
				value: 'revertVersion',
				action: 'Revert a file to an earlier version',
				description: 'Re-instate an earlier version as a new version',
			},
			{
				name: 'Upload',
				value: 'upload',
				action: 'Upload a file to an entry',
				description:
					'Upload binary data to an entry — becomes a new version if a file with the same name already exists, otherwise a new attachment',
			},
		],
		default: 'upload',
	},
	{
		...communitySelect,
		displayOptions: {
			show: showOnlyForFiles,
		},
	},
	{
		...roomSelect,
		displayOptions: {
			show: showOnlyForFiles,
		},
	},
	{
		displayName: 'Entry ID',
		name: 'entryId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'UUID of the entry the file is attached to',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['upload'],
			},
		},
	},
	{
		displayName: 'File ID',
		name: 'fileId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'UUID of the file',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['download', 'getVersions', 'revertVersion'],
			},
		},
	},
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		description: 'Name of the binary property holding the file to upload',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['upload'],
			},
		},
	},
	{
		displayName: 'File Name',
		name: 'fileName',
		type: 'string',
		default: '',
		description:
			'Overrides the binary data file name. Determines create-vs-new-version: a case-insensitive match against existing attachment names uploads a new version.',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['upload'],
			},
		},
	},
	{
		displayName: 'Put Output in Field',
		name: 'outputBinaryPropertyName',
		type: 'string',
		default: 'data',
		required: true,
		description: 'Name of the binary property to write the downloaded file into',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['download'],
			},
		},
	},
	{
		displayName: 'Version Label',
		name: 'versionLabel',
		type: 'string',
		default: '',
		required: true,
		description: 'Label of the version to revert to (as shown in the version history)',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['revertVersion'],
			},
		},
	},
	{
		displayName: 'Major Version',
		name: 'major',
		type: 'boolean',
		default: false,
		description: 'Whether the reverted version is stored as a new major version',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['revertVersion'],
			},
		},
	},
	{
		displayName: 'Comment',
		name: 'comment',
		type: 'string',
		default: '',
		description: 'Comment stored with the reverted version',
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['revertVersion'],
			},
		},
	},
	folderLocator(
		'location',
		'Search In',
		'Folder, workflow step or entry to search below. A path may end in a workflow step (e.g. /Design/Architecture/In Progress) to search only that step. Leave empty to search the whole room.',
		{ show: { ...showOnlyForFiles, operation: ['find'] } },
	),
	{
		displayName: 'File Name',
		name: 'findFileName',
		type: 'string',
		default: '',
		placeholder: 'e.g. *.ifc or A-40-V-0001.ifc',
		description:
			'Exact file name or glob pattern (* and ?). Matched case-insensitively unless Case Sensitive is set. Leave empty for all files.',
		displayOptions: { show: { ...showOnlyForFiles, operation: ['find'] } },
	},
	{
		displayName: 'Output',
		name: 'findOutput',
		type: 'options',
		default: 'items',
		options: [
			{
				name: 'One Item per File',
				value: 'items',
				description: 'Each file becomes an item; no items are returned when nothing matches',
			},
			{
				name: 'Single Summary Item',
				value: 'summary',
				description:
					'Always returns exactly one item: {found, count, files[], location} — nothing matching is visible instead of silently ending the branch',
			},
		],
		displayOptions: { show: { ...showOnlyForFiles, operation: ['find'] } },
	},
	...returnAllSelect.map((property) => ({
		...property,
		displayOptions: {
			show: {
				...showOnlyForFiles,
				operation: ['find'],
				...(property.displayOptions?.show ?? {}),
			},
		},
	})),
	{
		displayName: 'Options',
		name: 'findOptions',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: { show: { ...showOnlyForFiles, operation: ['find'] } },
		options: [
			{
				displayName: 'Case Sensitive',
				name: 'caseSensitive',
				type: 'boolean',
				default: false,
				description: 'Whether file and entry name matching is case-sensitive',
			},
			{
				displayName: 'Entry Name',
				name: 'entryName',
				type: 'string',
				default: '',
				placeholder: 'e.g. A-40-V-0001',
				description:
					'Only files attached to entries with this exact name (or glob). Exact — unlike the API, A-40-V-0001 does not also match A-40-V-0001_Part2.',
			},
			{
				displayName: 'Include Entry Fields',
				name: 'includeEntryFields',
				type: 'boolean',
				default: false,
				description:
					'Whether to add entry_fields: the metadata of the parent entry as {field name: value}',
			},
			{
				displayName: 'Include Entry Info',
				name: 'includeEntry',
				type: 'boolean',
				default: true,
				description:
					'Whether to add entry_id, entry_name, entry_step and entry_step_id of the parent entry to every file',
			},
			{
				displayName: 'Modified After',
				name: 'modifiedAfter',
				type: 'dateTime',
				default: '',
				description: 'Only files whose last_modified is later than this',
			},
			{
				displayName: 'Workflow Step',
				name: 'stepName',
				type: 'string',
				default: '',
				placeholder: 'e.g. In Progress',
				description:
					'Only files whose entry is currently in this workflow step (matched case-insensitively by name)',
			},
		],
	},
];

export async function fileFind(
	this: IExecuteFunctions,
	i: number,
): Promise<IDataObject | IDataObject[]> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const locator = this.getNodeParameter('location', i) as { mode: string; value: string };
	const fileName = this.getNodeParameter('findFileName', i, '') as string;
	const output = this.getNodeParameter('findOutput', i, 'items') as string;
	const returnAll = this.getNodeParameter('returnAll', i) as boolean;
	const limit = returnAll ? undefined : (this.getNodeParameter('limit', i) as number);
	const options = this.getNodeParameter('findOptions', i, {}) as {
		caseSensitive?: boolean;
		entryName?: string;
		includeEntry?: boolean;
		includeEntryFields?: boolean;
		modifiedAfter?: string;
		stepName?: string;
	};

	const location = await resolveLocation.call(this, community, room, locator);
	let files = await findFiles.call(this, community, room, location, {
		fileName,
		caseSensitive: options.caseSensitive,
		entryName: options.entryName,
		stepName: options.stepName,
		modifiedAfter: options.modifiedAfter ? new Date(options.modifiedAfter) : undefined,
		includeEntry: options.includeEntry ?? true,
		includeEntryFields: options.includeEntryFields,
	});
	if (limit !== undefined) files = files.slice(0, limit);

	if (output === 'summary') {
		return {
			found: files.length > 0,
			count: files.length,
			files,
			location: {
				id: location.id,
				type: location.type,
				path: location.path,
				step: location.step ? { id: location.step.id, name: location.step.name } : null,
			},
		};
	}
	return files;
}

export async function fileUpload(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const entryId = this.getNodeParameter('entryId', i) as string;
	const binaryPropertyName = this.getNodeParameter('binaryPropertyName', i) as string;

	const binaryData = this.helpers.assertBinaryData(i, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
	const fileName =
		(this.getNodeParameter('fileName', i, '') as string) || binaryData.fileName || 'file';

	// The universal production pattern: same basename (case-insensitive) among the
	// entry's attachments → new version; otherwise → new attachment.
	const children = await interaxoRequestPaged.call(
		this,
		`${roomPath(community, room)}/content/${encodeURIComponent(entryId)}/children`,
		{ pageSize: 200 },
	);
	const existing = children.find(
		(child) =>
			child.type === 'file' &&
			typeof child.name === 'string' &&
			child.name.toLowerCase() === fileName.toLowerCase(),
	);

	const path = existing
		? `${roomPath(community, room)}/files/${encodeURIComponent(existing.id as string)}/versions`
		: `${roomPath(community, room)}/content/${encodeURIComponent(entryId)}/children`;

	const response = await interaxoUploadFile.call(this, path, buffer, fileName, binaryData.mimeType);
	return {
		...response,
		uploadMode: existing ? 'newVersion' : 'newAttachment',
		// a version upload can re-issue the file's content id — the response
		// carries the current one; the pre-upload id may already be stale
		targetFileId: (response.id as string | undefined) ?? (existing ? existing.id : null),
	};
}

export async function fileDownload(
	this: IExecuteFunctions,
	i: number,
): Promise<INodeExecutionData> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const fileId = this.getNodeParameter('fileId', i) as string;
	const outputBinaryPropertyName = this.getNodeParameter('outputBinaryPropertyName', i) as string;

	const file = (await interaxoRequest.call(
		this,
		'GET',
		`${roomPath(community, room)}/content/${encodeURIComponent(fileId)}`,
	)) as IDataObject;

	const contentUrl = file.content_url as string | undefined;
	if (!contentUrl) {
		throw new NodeOperationError(this.getNode(), `Content item ${fileId} has no content_url`, {
			itemIndex: i,
		});
	}

	// content_url is pre-signed with an embedded JWT — authorization headers must NOT be sent
	const data = (await this.helpers.httpRequest({
		method: 'GET',
		url: contentUrl,
		encoding: 'arraybuffer',
		timeout: 300_000,
	})) as Buffer;

	const binary = await this.helpers.prepareBinaryData(data, (file.name as string) || fileId);
	return {
		json: file,
		binary: { [outputBinaryPropertyName]: binary },
		pairedItem: { item: i },
	};
}

export async function fileGetVersions(this: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const fileId = this.getNodeParameter('fileId', i) as string;

	// Version history lives on the legacy ix host and pages with start/limit
	const results: IDataObject[] = [];
	const limit = 100;
	for (let start = 0; ; start += limit) {
		const page = (await interaxoRequest.call(
			this,
			'GET',
			`/v1/${encodeURIComponent(community)}/ix/nodes/${encodeURIComponent(fileId)}/versions`,
			{
				host: 'ix',
				qs: { roomId: room, nodeId: fileId, expand: 'authorities', limit, start },
			},
		)) as IDataObject[] | IDataObject;
		const items = Array.isArray(page) ? page : ((page.versions as IDataObject[]) ?? []);
		results.push(...items);
		if (items.length < limit) break;
	}
	return results;
}

export async function fileRevertVersion(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const fileId = this.getNodeParameter('fileId', i) as string;
	const versionLabel = this.getNodeParameter('versionLabel', i) as string;
	const major = this.getNodeParameter('major', i) as boolean;
	const comment = this.getNodeParameter('comment', i, '') as string;

	return (await interaxoRequest.call(
		this,
		'POST',
		`/api/${encodeURIComponent(community)}/rooms/${encodeURIComponent(room)}/documents/file/${encodeURIComponent(fileId)}/revert`,
		{
			host: 'ix',
			body: { major, comment, versionLabel },
		},
	)) as IDataObject;
}

export const fileHandlers = {
	download: fileDownload,
	find: fileFind,
	getVersions: fileGetVersions,
	revertVersion: fileRevertVersion,
	upload: fileUpload,
};
