import { CloudFrontRequestEvent, CloudFrontResponseEvent, CloudFrontResultResponse } from 'aws-lambda';
import flatCache from 'flat-cache';

import { Behavior } from './../function-set';

import parseCacheControl from 'parse-cache-control';

import { CacheId } from '../constants';

export class CacheService {
	private cache: FlatCache;

	constructor(private cacheDir: string) {
		this.cache = flatCache.load(CacheId, cacheDir);
	}

	retrieveFromCache(event: CloudFrontRequestEvent) {
		const { request } = event.Records[0].cf;
		const { uri } = request;

		const result = this.cache.getKey(uri);

		if (result) {
			if (Date.parse(result.expire) > Date.now()) {
				return result.body;
			} else {
				this.cache.removeKey(uri);
				this.cache.save();
			}
		}
	}

	saveToCache(event: CloudFrontResponseEvent, behavior: Behavior) {
		const { request, response } = event.Records[0].cf;
		const { uri } = request;

		const { body, headers } = response as CloudFrontResultResponse;

		let ttl = behavior.defaultTTL;

		if (headers) {
			let cacheControlStr;
			let cacheControl: Array<{ key?: string | undefined; value: string; }> | string = headers['cache-control'];
			if (typeof cacheControl === "string") {
				cacheControlStr = cacheControl;
			} else if (typeof cacheControl === "object" && Array.isArray(cacheControl)) {
				cacheControlStr = cacheControl?.[0]?.value || "";
			}
			if (cacheControlStr) {
				const parsed = parseCacheControl(cacheControlStr);
				ttl = parsed?.['max-age'] || ttl;
			}
		}

		if (ttl > behavior.maxTTL) {
			ttl = behavior.maxTTL;
		} else if (ttl < behavior.minTTL) {
			ttl = behavior.minTTL;
		}

		const expire = new Date();
		expire.setSeconds(expire.getSeconds() + ttl);

		this.cache.setKey(uri, {
			expire: expire.toISOString(),
			body
		});
		this.cache.save();
	}

	public async purge() {
		flatCache.clearCacheById(CacheId);

		// FIXME Workaround. Bug in flat-cache clear methods.
		Object.entries(this.cache.all()).forEach(entry => {
			this.cache.removeKey(entry[0]);
		});
	}
}
