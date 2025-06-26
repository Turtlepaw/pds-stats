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
