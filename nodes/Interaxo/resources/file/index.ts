import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeProperties,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { communitySelect, roomSelect } from '../../shared/descriptions';
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
				name: 'Get Versions',
				value: 'getVersions',
				action: 'Get the version history of a file',
				description: 'Get the version history including uploader identities',
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
];

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
		targetFileId: existing ? existing.id : (response.id ?? null),
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
	getVersions: fileGetVersions,
	revertVersion: fileRevertVersion,
	upload: fileUpload,
};
