import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { communitySelect, roomSelect } from '../../shared/descriptions';
import { getRlc, interaxoRequest, roomPath } from '../../shared/transport';

const showOnlyForRooms = {
	resource: ['room'],
};

export const roomDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForRooms,
		},
		options: [
			{
				name: 'Get',
				value: 'get',
				action: 'Get a room',
				description: 'Get a room, including its content root ID (content.root_id)',
			},
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many rooms',
				description: 'List the rooms in a community',
			},
		],
		default: 'getAll',
	},
	{
		...communitySelect,
		displayOptions: {
			show: showOnlyForRooms,
		},
	},
	{
		...roomSelect,
		displayOptions: {
			show: {
				...showOnlyForRooms,
				operation: ['get'],
			},
		},
	},
];

export async function roomGetAll(this: IExecuteFunctions, i: number): Promise<IDataObject[]> {
	const community = getRlc(this, 'community', i);
	return (await interaxoRequest.call(
		this,
		'GET',
		`/v1/${encodeURIComponent(community)}/rooms`,
	)) as IDataObject[];
}

export async function roomGet(this: IExecuteFunctions, i: number): Promise<IDataObject> {
	const community = getRlc(this, 'community', i);
	const room = getRlc(this, 'room', i);
	return (await interaxoRequest.call(this, 'GET', roomPath(community, room))) as IDataObject;
}

export const roomHandlers = {
	get: roomGet,
	getAll: roomGetAll,
};
