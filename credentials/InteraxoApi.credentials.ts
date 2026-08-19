import type {
	IAuthenticateGeneric,
	ICredentialDataDecryptedObject,
	ICredentialTestRequest,
	ICredentialType,
	IHttpRequestHelper,
	Icon,
	INodeProperties,
} from 'n8n-workflow';

export class InteraxoApi implements ICredentialType {
	name = 'interaxoApi';

	displayName = 'Interaxo API';

	icon: Icon = { light: 'file:../icons/interaxo.svg', dark: 'file:../icons/interaxo.dark.svg' };

	documentationUrl = 'https://github.com/byggstyrning/n8n-nodes-interaxo#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Client ID',
			name: 'clientId',
			type: 'string',
			default: '',
			required: true,
			description: 'OAuth2 machine-to-machine client ID issued for the Interaxo API',
		},
		{
			displayName: 'Client Secret',
			name: 'clientSecret',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
		{
			displayName: 'Token URL',
			name: 'tokenUrl',
			type: 'string',
			default: 'https://login.collaboration-sso.com/oauth/token',
			description: 'OAuth2 client-credentials token endpoint',
		},
		{
			displayName: 'Audience',
			name: 'audience',
			type: 'string',
			default: 'https://api.interaxo.com/v1/',
			description: 'OAuth2 audience claim requested for the access token',
		},
		{
			displayName: 'API Base URL',
			name: 'apiUrl',
			type: 'string',
			default: 'https://api.interaxo.se',
			description: 'Primary Interaxo REST API host',
		},
		{
			displayName: 'IX Base URL',
			name: 'ixUrl',
			type: 'string',
			default: 'https://ix.interaxo.se',
			description: 'Legacy host used for version history, version revert and pre-signed downloads',
		},
		{
			displayName: 'Session Token',
			name: 'sessionToken',
			type: 'hidden',
			typeOptions: { password: true, expirable: true },
			default: '',
		},
	];

	// Fetches and caches a client-credentials access token. n8n re-runs this
	// when the token expires or a request comes back 401, which also keeps
	// pressure off the Auth0 M2M grant quota.
	async preAuthentication(this: IHttpRequestHelper, credentials: ICredentialDataDecryptedObject) {
		const response = (await this.helpers.httpRequest({
			method: 'POST',
			url: credentials.tokenUrl as string,
			body: {
				grant_type: 'client_credentials',
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				audience: credentials.audience,
			},
			json: true,
		})) as { access_token: string };
		return { sessionToken: response.access_token };
	}

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: {
				Authorization: '=Bearer {{$credentials.sessionToken}}',
				'X-Requested-With': 'XMLHttpRequest',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.apiUrl}}',
			url: '/v1',
			method: 'GET',
		},
	};
}
