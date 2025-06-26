import { AtpAgent, CredentialSession } from '@atproto/api';
import { Host } from '@atproto/api/dist/client/types/com/atproto/sync/listHosts';
import { Cache } from '../../../cache';

export async function GET(req: Request) {
	const url = new URL(req.url);
	const cache = new Cache();

	// CORS headers
	const corsHeaders = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Content-Type': 'application/json',
	};

	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	// GET /pds/hostname
	if (url.pathname.startsWith('/pds/')) {
		const pdsHost = url.pathname.split('/')[2];
		const cacheKey = `${CACHE_KEY_PREFIX}${pdsHost}`;

		if (!pdsHost) {
			return new Response(JSON.stringify({ error: 'PDS host required' }), {
				status: 400,
				headers: corsHeaders,
			});
		}

		try {
			// Check cache first
			const cachedData = await cache.get(cacheKey);
			console.log(`Checking cache for ${pdsHost}:`, cachedData ? 'found' : 'not found');
			let result: PDSInfo;
			if (cachedData && cachedData) {
				result = JSON.parse(cachedData);
			} else {
				// Dynamic fetch if not cached
				const count = await fetchPDSAccountCount(pdsHost);
				result = {
					host: pdsHost,
					accounts: count,
					updated_at: new Date().toISOString(),
					source: 'dynamic',
				};

				await cache.set(cacheKey, JSON.stringify(result), CACHE_DURATION);
			}

			return new Response(JSON.stringify(result), {
				headers: { ...corsHeaders, 'Cache-Control': `public, max-age=${DYNAMIC_CACHE_DURATION}` },
			});
		} catch (error) {
			console.error(`Failed to fetch PDS data for ${pdsHost}:`, error);
			return new Response(
				JSON.stringify({
					error: 'Failed to fetch PDS data',
					host: pdsHost,
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
	}

	// GET /pds - list all cached
	if (url.pathname === '/pds' || url.pathname === '/pds/') {
		return new Response(
			JSON.stringify({
				error: 'PDS host required, please use /pds/<hostname>',
				host: null,
			}),
			{
				status: 500,
				headers: corsHeaders,
			}
		);
	}

	return new Response('Not found', { status: 404 });
}

async function fetchAllHosts(agent: AtpAgent): Promise<Host[]> {
	let allHosts: Host[] = [];
	let cursor: string | undefined;

	while (true) {
		const result = await agent.com.atproto.sync.listHosts({ limit: 1000, cursor });
		if (!result.success) {
			throw new Error(`Failed to fetch hosts`);
		}

		const hosts = result.data.hosts || [];
		// Filter for *.bsky.network hosts
		const bskyHosts = hosts.filter((h) => h.hostname.endsWith('.bsky.network'));
		allHosts.push(...bskyHosts);

		if (!result.data.cursor || hosts.length === 0) break;
		cursor = result.data.cursor;
	}

	return allHosts;
}

async function recurseFetchBlueskyPdsCollection(): Promise<number> {
	const session = new CredentialSession(new URL('https://relay1.us-west.bsky.network'));
	const agent = new AtpAgent(session);
	const pdsList = await fetchAllHosts(agent);
	let accounts = 0;
	for (const pds of pdsList) {
		try {
			const count = await fetchPDSAccountCount(pds.hostname);
			accounts += count;
			console.log(`PDS: ${pds.hostname}, Accounts: ${count}`);
		} catch (error) {
			console.error(`Failed to fetch accounts for PDS ${pds.hostname}:`, error);
		}
	}
	return accounts;
}

async function fetchPDSAccountCount(pdsHost: string): Promise<number> {
	// Get repo count as approximation of account count
	let totalRepos = 0;
	let cursor: string | undefined;
	let attempts = 0;

	console.log(`Fetching account count for PDS: ${pdsHost}`);

	const baseUrl = pdsHost.startsWith('http') ? pdsHost : `https://${pdsHost}`;

	if (pdsHost.startsWith('bsky.social')) {
		// Special case for bsky.social, which uses a different endpoint
		console.log('Using special handling for bsky.social');
		return recurseFetchBlueskyPdsCollection();
	}

	const session = new CredentialSession(new URL(baseUrl));
	const agent = new AtpAgent(session);

	while (attempts < Infinity) {
		// Limit attempts
		const response = await agent.com.atproto.sync.listRepos({ cursor, limit: 1000 });

		if (!response.success) {
			if (attempts === 0) throw new Error(`Failed to fetch repos from ${pdsHost}`);
			break;
		}

		const data = response.data;
		totalRepos += data.repos?.length || 0;

		if (!data.cursor || !data.repos?.length) break;
		cursor = data.cursor;
		attempts++;
	}

	return totalRepos;
}
