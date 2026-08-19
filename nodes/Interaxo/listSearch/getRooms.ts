import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { interaxoRequest } from '../shared/transport';

export async function getRooms(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const community = this.getCurrentNodeParameter('community', { extractValue: true }) as string;
	if (!community) return { results: [] };

	const rooms = (await interaxoRequest.call(
		this,
		'GET',
		`/v1/${encodeURIComponent(community)}/rooms`,
	)) as Array<{ id: string; name?: string; description?: string }>;

	let results = (rooms ?? []).map((room) => ({
		name: room.name || room.id,
		value: room.id,
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
