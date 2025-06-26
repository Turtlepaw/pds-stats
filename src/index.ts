import { AtpAgent, CredentialSession } from '@atproto/api';

interface Env {
	BSKY_PASSWORD: string;
	BSKY_USERNAME: string;
	PDS_CACHE: KVNamespace;
}

interface PDSInfo {
	host: string;
	accounts: number;
	updated_at: string;
	source: 'cron' | 'dynamic';
}

const CACHE_KEY_PREFIX = 'pds_data:';
const CACHE_DURATION = 6 * 60 * 60; // 6 hours
const DYNAMIC_CACHE_DURATION = 60 * 60; // 1 hour

// Known Bluesky PDSes
const KNOWN_PDSES = ['bsky.social', 'witchcraft.systems'];

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);

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
				const cachedData = env.PDS_CACHE ? await env.PDS_CACHE.get(cacheKey) : null;
				console.log(`Checking cache for ${pdsHost}:`, cachedData ? 'found' : 'not found');
				let result: PDSInfo;
				if (cachedData) {
					result = JSON.parse(cachedData);
				} else {
					// Dynamic fetch if not cached
					const count = await fetchPDSAccountCount(pdsHost, env);
					result = {
						host: pdsHost,
						accounts: count,
						updated_at: new Date().toISOString(),
						source: 'dynamic',
					};

					await env.PDS_CACHE.put(cacheKey, JSON.stringify(result), {
						expirationTtl: CACHE_DURATION,
					});
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
	},

	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		console.log('Refreshing PDS data...');

		const pdsData: PDSInfo[] = [];

		for (const pdsHost of KNOWN_PDSES) {
			try {
				const count = await fetchPDSAccountCount(pdsHost, env);
				const cacheKey = `${CACHE_KEY_PREFIX}${pdsHost}`;

				const pdsInfo: PDSInfo = {
					host: pdsHost,
					accounts: count,
					updated_at: new Date().toISOString(),
					source: 'cron',
				};

				pdsData.push(pdsInfo); // only for in-memory summary (optional)

				await env.PDS_CACHE.put(cacheKey, JSON.stringify(pdsInfo), {
					expirationTtl: CACHE_DURATION,
				});

				console.log(`${pdsHost}: ${count} accounts`);
			} catch (error) {
				console.error(`Failed to fetch ${pdsHost}:`, error);
			}
		}

		console.log(`Updated ${pdsData.length} PDSes`);
	},
} satisfies ExportedHandler<Env>;

async function fetchPDSAccountCount(pdsHost: string, env: Env): Promise<number> {
	// Get repo count as approximation of account count
	let totalRepos = 0;
	let cursor: string | undefined;
	let attempts = 0;

	console.log(`Fetching account count for PDS: ${pdsHost}`);

	const baseUrl = pdsHost.startsWith('http') ? pdsHost : `https://${pdsHost}`;

	const session = new CredentialSession(new URL(baseUrl));
	if (pdsHost.startsWith('bsky.social'))
		await session.login({
			identifier: env.BSKY_USERNAME,
			password: env.BSKY_PASSWORD,
		});
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
