import { Redis } from '@upstash/redis';

export class Cache {
	private redis: Redis;

	constructor() {
		this.redis = Redis.fromEnv();
	}

	async get(key: string): Promise<object | null> {
		try {
			return await this.redis.get(key);
		} catch (error) {
			console.error(`Cache get error for key ${key}:`, error);
			return null;
		}
	}

	async set(key: string, value: string, ttl?: number): Promise<void> {
		try {
			await this.redis.set(key, value, ttl ? { ex: ttl } : undefined);
		} catch (error) {
			console.error(`Cache set error for key ${key}:`, error);
		}
	}

	async delete(key: string): Promise<void> {
		try {
			await this.redis.del(key);
		} catch (error) {
			console.error(`Cache delete error for key ${key}:`, error);
		}
	}
}
