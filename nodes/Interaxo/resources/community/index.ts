import type { IDataObject, IExecuteFunctions, INodeProperties } from 'n8n-workflow';
import { interaxoRequest } from '../../shared/transport';

const showOnlyForCommunities = {
	resource: ['community'],
};

export const communityDescription: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: {
			show: showOnlyForCommunities,
		},
		options: [
			{
				name: 'Get Many',
				value: 'getAll',
				action: 'Get many communities',
				description: 'Retrieve a list of communities the credential has access to',
			},
		],
		default: 'getAll',
	},
];

export async function communityGetAll(this: IExecuteFunctions): Promise<IDataObject[]> {
	return (await interaxoRequest.call(this, 'GET', '/v1/communities')) as IDataObject[];
}

export const communityHandlers = {
	getAll: communityGetAll,
};
