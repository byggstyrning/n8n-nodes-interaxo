import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { interaxoRequest } from '../shared/transport';

export async function getCommunities(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const communities = (await interaxoRequest.call(this, 'GET', '/v1')) as Array<{
		id: string;
		name?: string;
	}>;

	let results = (communities ?? []).map((community) => ({
		name: community.name || community.id,
		value: community.id,
	}));

	if (filter) {
		const needle = filter.toLowerCase();
		results = results.filter(
			(item) =>
				item.name.toLowerCase().includes(needle) || String(item.value).toLowerCase().includes(needle),
		);
	}

	return { results };
}
