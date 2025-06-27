import { AtpAgent, CredentialSession } from '@atproto/api';
import { Host } from '@atproto/api/dist/client/types/com/atproto/sync/listHosts';
import { Cache } from '../../../cache';
import { CACHE_DURATION, CACHE_KEY_PREFIX, DYNAMIC_CACHE_DURATION } from '../../../constants';
import { PDSInfo } from '../../../types';

// Tune this value as needed for your environment
const PDS_FETCH_CONCURRENCY = 40;

// Set to true for fast mode (estimate with first few pages)
const PDS_FAST_MODE = true;
const PDS_FAST_MODE_PAGES = 10;
const PDS_FAST_MODE_MULTIPLIER = 2;

// Fastest mode: fetch only the first 2 pages, sum, and if both are full, return 'at least' that number
const PDS_FASTEST_MODE = true;
const PDS_FASTEST_MODE_PAGES = 2;
const PDS_FASTEST_MODE_LIMIT = 1000;

export async function GET(req: Request, { params }: { params: { hostname?: string[] } }) {
	const hostname = (await params).hostname?.[0];
	const cache = new Cache();
	const startTime = Date.now();
	console.log(`Received request for PDS data: ${hostname} at ${new Date().toISOString()}`);

	// CORS headers
	const corsHeaders = {
		'Access-Control-Allow-Origin': '*',
		'Access-Control-Allow-Methods': 'GET, OPTIONS',
		'Content-Type': 'application/json',
	};

	if (req.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders });
	}

	console.log(`Received request for ${hostname}`);
	// GET /pds/hostname
	if (hostname != null && hostname !== '') {
		const cacheKey = `${CACHE_KEY_PREFIX}${hostname}`;

		if (!hostname) {
			return new Response(JSON.stringify({ error: 'PDS host required' }), {
				status: 400,
				headers: corsHeaders,
			});
		}

		try {
			// Check cache first
			const cachedData = null; //(await cache.get(cacheKey)) as PDSInfo | null;
			console.log(`Checking cache for ${hostname}:`, cachedData, typeof cachedData);
			let result: PDSInfo;
			if (cachedData && cachedData) {
				result = cachedData;
			} else {
				// Dynamic fetch if not cached
				const count = await fetchPDSAccountCount(hostname);
				result = {
					host: hostname,
					accounts: count,
					updated_at: new Date().toISOString(),
					source: 'dynamic',
				};

				await cache.set(cacheKey, JSON.stringify(result), CACHE_DURATION);
			}

			const elapsedMs = Date.now() - startTime;
			const minutes = Math.floor(elapsedMs / 60000);
			const seconds = Math.floor((elapsedMs % 60000) / 1000);
			console.log(`Returning PDS data for ${hostname}:`, result, ' took ', `${minutes} minutes ${seconds} seconds`);

			return new Response(JSON.stringify(result), {
				headers: { ...corsHeaders, 'Cache-Control': `public, max-age=${DYNAMIC_CACHE_DURATION}` },
			});
		} catch (error) {
			console.error(`Failed to fetch PDS data for ${hostname}:`, error);
			return new Response(
				JSON.stringify({
					error: 'Failed to fetch PDS data',
					host: hostname,
				}),
				{
					status: 500,
					headers: corsHeaders,
				}
			);
		}
	}

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

	let index = 0;

	async function worker() {
		while (index < pdsList.length) {
			const myIndex = index++;
			const pds = pdsList[myIndex];
			try {
				accounts += pds.accountCount || 0;
				console.log(`PDS: ${pds.hostname}, Accounts: ${pds.accountCount}`);
			} catch (error) {
				console.error(`Failed to fetch accounts for PDS ${pds.hostname}:`, error);
			}
		}
	}

	// Start workers with increased concurrency
	await Promise.all(Array.from({ length: PDS_FETCH_CONCURRENCY }, worker));
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

	let pageCount = 0;
	let lastPageLength = 0;
	let allPagesFull = true;

	while (attempts < PDS_FASTEST_MODE_PAGES) {
		const response = await agent.com.atproto.sync.listRepos({ cursor, limit: PDS_FASTEST_MODE_LIMIT });

		if (!response.success) {
			if (attempts === 0) throw new Error(`Failed to fetch repos from ${pdsHost}`);
			break;
		}

		const data = response.data;
		const reposLength = data.repos?.length || 0;
		totalRepos += reposLength;
		lastPageLength = reposLength;
		pageCount++;

		if (reposLength < PDS_FASTEST_MODE_LIMIT) {
			allPagesFull = false;
		}

		if (!data.cursor || !reposLength) break;
		cursor = data.cursor;
		attempts++;
	}

	if (PDS_FASTEST_MODE) {
		if (allPagesFull) {
			console.log(`Fastest mode: at least ${totalRepos} repos for ${pdsHost} (all sampled pages full)`);
			return totalRepos; // Optionally, return `${totalRepos}+` to indicate lower bound
		} else {
			console.log(`Fastest mode: ${totalRepos} repos for ${pdsHost} (last page not full)`);
			return totalRepos;
		}
	}

	return totalRepos;
}
