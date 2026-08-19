import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { communitySelect, roomSelect } from '../../shared/descriptions';
import { getRlc, interaxoRequest, roomPath } from '../../shared/transport';

const showOnlyForEntries = {
	resource: ['entry'],
};

export const entryDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForEntries,
		},
		options: [
			{
				name: 'Create',
				value: 'create',
				action: 'Create an entry',
				description: 'Create a new metadata entry in an active-folder or workflow-folder',
			},
			{
				name: 'Get Field Schema',
				value: 'getFields',
				action: 'Get the field schema of a folder',
				description:
					'Retrieve the field definitions and workflow steps of an active-folder or workflow-folder',
			},
			{
				name: 'Move to Step',
				value: 'moveStep',
				action: 'Move an entry to a workflow step',
				description: 'Move an entry to another step in its workflow-folder',
			},
		],
		default: 'create',
	},
	{
		...communitySelect,
		displayOptions: {
			show: showOnlyForEntries,
		},
	},
	{
		...roomSelect,
		displayOptions: {
			show: showOnlyForEntries,
		},
	},
	{
		displayName: 'Folder ID',
		name: 'folderId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'UUID of the active-folder or workflow-folder',
		displayOptions: {
			show: {
				...showOnlyForEntries,
				operation: ['create', 'getFields'],
			},
		},
	},
	{
		displayName: 'Fields',
		name: 'fieldsJson',
		type: 'json',
		default: '[]',
		description:
			'Array of field values, e.g. [{"name": "NAMN", "value": "K-30-V-4401"}]. Fields are matched to the folder schema by display name or field UUID; the field type is resolved from the schema.',
		displayOptions: {
			show: {
				...showOnlyForEntries,
				operation: ['create'],
			},
		},
	},
	{
		displayName: 'Sanitize Fields',
		name: 'sanitize',
		type: 'boolean',
		default: true,
		description:
			'Whether to apply the known validation rules before posting: drop auto-number and read-only fields, drop empty non-mandatory fields, wrap values of multi-value fields in arrays',
		displayOptions: {
			show: {
				...showOnlyForEntries,
				operation: ['create'],
			},
		},
	},
	{
		displayName: 'Entry ID',
		name: 'entryId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		description: 'UUID of the entry to move',
		displayOptions: {
			show: {
				...showOnlyForEntries,
				operation: ['moveStep'],
			},
		},
	},
	{
		displayName: 'Step ID',
		name: 'stepId',
		type: 'string',
		default: '',
		required: true,
		placeholder: 'e.g. 5d6e7f80-91a2-4b3c-8d4e-5f6a7b8c9d0e',
		description: 'UUID of the target workflow step (see Get Field Schema for the steps of a folder)',
		displayOptions: {
			show: {
				...showOnlyForEntries,
				operation: ['moveStep'],
			},
		},
	},
];

interface SchemaField {
	id: string;
	name: string;
	type: string;
	mandatory?: boolean;
	read_only?: boolean;
	multiple?: boolean;
}

function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined ||
		value === null ||
		value === '' ||
		(Array.isArray(value) && value.length === 0)
	);
}

export async function entryGetFields(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const folderId = this.getNodeParameter('folderId', i) as string;

	const folder = (await interaxoRequest.call(
		this,
		'GET',
		`${roomPath(community, room)}/content/${encodeURIComponent(folderId)}`,
	)) as IDataObject;

	return {
		id: folder.id,
		name: folder.name,
		type: folder.type,
		fields: folder.fields ?? [],
		steps: folder.steps ?? [],
	};
}

export async function entryCreate(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const folderId = this.getNodeParameter('folderId', i) as string;
	const sanitize = this.getNodeParameter('sanitize', i) as boolean;

	const rawFields = this.getNodeParameter('fieldsJson', i);
	let inputFields: Array<IDataObject>;
	try {
		inputFields = typeof rawFields === 'string' ? JSON.parse(rawFields) : (rawFields as never);
	} catch {
		throw new NodeOperationError(this.getNode(), 'Fields must be valid JSON', { itemIndex: i });
	}
	if (!Array.isArray(inputFields)) {
		throw new NodeOperationError(this.getNode(), 'Fields must be a JSON array', { itemIndex: i });
	}

	const folder = (await interaxoRequest.call(
		this,
		'GET',
		`${roomPath(community, room)}/content/${encodeURIComponent(folderId)}`,
	)) as IDataObject;
	if (folder.type !== 'active-folder' && folder.type !== 'workflow-folder') {
		throw new NodeOperationError(
			this.getNode(),
			`Entries can only be created in an active-folder or workflow-folder (got "${folder.type}")`,
			{ itemIndex: i },
		);
	}
	const schema = (folder.fields ?? []) as SchemaField[];
	const byId = new Map(schema.map((field) => [field.id, field]));
	const byName = new Map(schema.map((field) => [field.name.toLowerCase(), field]));

	const fields: IDataObject[] = [];
	for (const input of inputFields) {
		const schemaField = input.id
			? byId.get(input.id as string)
			: byName.get(String(input.name ?? '').toLowerCase());
		if (!schemaField) {
			if (sanitize) continue;
			throw new NodeOperationError(
				this.getNode(),
				`Unknown field "${(input.name ?? input.id) as string}" in folder "${folder.name}"`,
				{ itemIndex: i },
			);
		}

		let value = input.value;
		if (sanitize) {
			// Rules learned in production: these all cause validation_error otherwise
			if (schemaField.type === 'auto-number' || schemaField.read_only) continue;
			if (!schemaField.mandatory && isEmptyValue(value)) continue;
			// list values are stored as arrays even for single-select lists
			if ((schemaField.type === 'list' || schemaField.multiple) && !Array.isArray(value)) {
				value = [value];
			}
		}

		fields.push({ id: schemaField.id, type: schemaField.type, value });
	}

	if (sanitize) {
		// Interaxo answers a bare "validation_error" when mandatory fields are
		// missing — check up front and name them instead
		const providedIds = new Set(fields.map((field) => field.id));
		const missing = schema
			.filter(
				(field) =>
					field.mandatory &&
					!field.read_only &&
					field.type !== 'auto-number' &&
					!providedIds.has(field.id),
			)
			.map((field) => field.name);
		if (missing.length) {
			throw new NodeOperationError(
				this.getNode(),
				`Missing mandatory field(s) for folder "${folder.name as string}": ${missing.join(', ')}`,
				{ itemIndex: i },
			);
		}
	}

	// step deliberately omitted: Interaxo places new entries in the initial workflow
	// step; sending one explicitly often trips step-specific validation rules
	return (await interaxoRequest.call(
		this,
		'POST',
		`${roomPath(community, room)}/content/${encodeURIComponent(folderId)}/children`,
		{ body: { type: 'entry', fields } },
	)) as IDataObject;
}

export async function entryMoveStep(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	const entryId = this.getNodeParameter('entryId', i) as string;
	const stepId = this.getNodeParameter('stepId', i) as string;

	// The move endpoint hangs off the workflow FOLDER, with the entry id as the
	// request body (a bare JSON string): POST .../content/{folderId}/steps/{stepId} → 204
	const entry = (await interaxoRequest.call(
		this,
		'GET',
		`${roomPath(community, room)}/content/${encodeURIComponent(entryId)}`,
	)) as IDataObject;
	const folderId = entry.parent_id as string | undefined;
	if (!folderId) {
		throw new NodeOperationError(this.getNode(), `Entry ${entryId} has no parent folder`, {
			itemIndex: i,
		});
	}

	await interaxoRequest.call(
		this,
		'POST',
		`${roomPath(community, room)}/content/${encodeURIComponent(folderId)}/steps/${encodeURIComponent(stepId)}`,
		{
			// the API wants the entry id as a bare JSON string ("uuid") — encode it
			// ourselves so nothing re-serializes it
			body: JSON.stringify(entryId),
			option: { json: false, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } },
		},
	);
	return { success: true, entryId, stepId, previousStep: entry.step ?? null };
}

export const entryHandlers = {
	create: entryCreate,
	getFields: entryGetFields,
	moveStep: entryMoveStep,
};
