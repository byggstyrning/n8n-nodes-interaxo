import type { INodeProperties } from 'n8n-workflow';

export const communitySelect: INodeProperties = {
	displayName: 'Community',
	name: 'community',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The Interaxo community (e.g. yourcompany.com)',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select a community...',
			typeOptions: {
				searchListMethod: 'getCommunities',
				searchable: true,
			},
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. yourcompany.com',
		},
	],
};

// Rooms are addressed by slug in the API, but existing workflows also pass the
// content root UUID — the API accepts both, hence both manual modes.
export const roomSelect: INodeProperties = {
	displayName: 'Room',
	name: 'room',
	type: 'resourceLocator',
	default: { mode: 'list', value: '' },
	required: true,
	description: 'The room within the community',
	modes: [
		{
			displayName: 'From List',
			name: 'list',
			type: 'list',
			placeholder: 'Select a room...',
			typeOptions: {
				searchListMethod: 'getRooms',
				searchable: true,
			},
		},
		{
			displayName: 'By Slug',
			name: 'slug',
			type: 'string',
			placeholder: 'e.g. project-room',
		},
		{
			displayName: 'By ID',
			name: 'id',
			type: 'string',
			placeholder: 'e.g. 9f0c1e2d-3b4a-4c6d-8e8f-901a2b3c4d5e',
		},
	],
};

export const returnAllSelect: INodeProperties[] = [
	{
		displayName: 'Return All',
		name: 'returnAll',
		type: 'boolean',
		default: false,
		description: 'Whether to return all results or only up to a given limit',
	},
	{
		displayName: 'Limit',
		name: 'limit',
		type: 'number',
		typeOptions: { minValue: 1 },
		default: 50,
		description: 'Max number of results to return',
		displayOptions: {
			show: {
				returnAll: [false],
			},
		},
	},
];
