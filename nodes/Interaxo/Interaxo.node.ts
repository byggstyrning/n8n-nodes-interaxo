import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { getCommunities } from './listSearch/getCommunities';
import { getRooms } from './listSearch/getRooms';
import { communityDescription, communityHandlers } from './resources/community';
import { contentDescription, contentHandlers } from './resources/content';
import { entryDescription, entryHandlers } from './resources/entry';
import { fileDescription, fileHandlers } from './resources/file';
import { roomDescription, roomHandlers } from './resources/room';

type OperationHandler = (
	this: IExecuteFunctions,
	i: number,
) => Promise<IDataObject | IDataObject[] | INodeExecutionData>;

const handlers: Record<string, Record<string, OperationHandler>> = {
	community: communityHandlers,
	content: contentHandlers,
	entry: entryHandlers,
	file: fileHandlers,
	room: roomHandlers,
};

function isExecutionData(value: unknown): value is INodeExecutionData {
	return (
		typeof value === 'object' &&
		value !== null &&
		'json' in value &&
		('binary' in value || 'pairedItem' in value)
	);
}

export class Interaxo implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Interaxo',
		name: 'interaxo',
		icon: { light: 'file:../../icons/interaxo.svg', dark: 'file:../../icons/interaxo.dark.svg' },
		group: ['input'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Work with rooms, folders, entries and files in Interaxo (Tribia)',
		defaults: {
			name: 'Interaxo',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'interaxoApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{
						name: 'Community',
						value: 'community',
					},
					{
						name: 'Content',
						value: 'content',
					},
					{
						name: 'Entry',
						value: 'entry',
					},
					{
						name: 'File',
						value: 'file',
					},
					{
						name: 'Room',
						value: 'room',
					},
				],
				default: 'content',
			},
			...communityDescription,
			...contentDescription,
			...entryDescription,
			...fileDescription,
			...roomDescription,
		],
	};

	methods = {
		listSearch: {
			getCommunities,
			getRooms,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const resource = this.getNodeParameter('resource', 0) as string;
		const operation = this.getNodeParameter('operation', 0) as string;

		const handler = handlers[resource]?.[operation];
		if (!handler) {
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for resource "${resource}"`,
			);
		}

		for (let i = 0; i < items.length; i++) {
			try {
				const result = await handler.call(this, i);
				if (Array.isArray(result)) {
					for (const entry of result) {
						returnData.push({ json: entry, pairedItem: { item: i } });
					}
				} else if (isExecutionData(result)) {
					returnData.push({ ...result, pairedItem: { item: i } });
				} else {
					returnData.push({ json: result as IDataObject, pairedItem: { item: i } });
				}
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: error instanceof Error ? error.message : String(error) },
						pairedItem: { item: i },
					});
					continue;
				}
				throw error instanceof NodeApiError || error instanceof NodeOperationError
					? error
					: new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
