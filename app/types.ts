export interface PDSInfo {
	host: string;
	accounts: number;
	updated_at: string;
	source: 'cron' | 'dynamic';
}
