import {
	CloudFrontRequestEvent, CloudFrontResponseResult, CloudFrontResultResponse, Context
} from 'aws-lambda';

import { MethodNotAllowedError } from '../errors/http';
import { NoResult } from '../errors';
import { FunctionSet } from '../function-set';
import { combineResult, isResponseResult, toResultResponse } from '../utils';
import { CacheService } from './cache.service';
import { ServerlessInstance, ServerlessOptions } from '../types';

export class CloudFrontLifecycle {

	private readonly log: (message: string) => void;

	constructor(
		private readonly serverless: ServerlessInstance,
		private options: ServerlessOptions,
		private event: CloudFrontRequestEvent,
		private context: Context,
		private fileService: CacheService,
		private fnSet: FunctionSet
	) {
		this.log = serverless.cli.log.bind(serverless.cli);
	}

	async run(url: string): Promise<CloudFrontResponseResult | void> {

		this.fnSet.origin.init(this.event);
		
		const method = this.event.Records[0].cf.request.method;

		this.log(`${method} ${url}`);

		if (!this.fnSet.behavior.allowedMethods.includes(method))
		{
			this.log('✗  Method Not Allowed');
			throw new MethodNotAllowedError("Cloudfront method not allowed");
		}

		try {
			return await this.onViewerRequest();
		} catch (err) {
			if (!(err instanceof NoResult)) {
				throw err;
			}
		}

		try {
			return await this.onCache();
		} catch (err) {
			if (!(err instanceof NoResult)) {
				throw err;
			}
		}

		let result = await this.onOriginRequest();

		if (this.canCache()) {
			await this.fileService.saveToCache(combineResult(this.event, result), this.fnSet.behavior);
		}

		result = await this.onViewerResponse(result);
		if (result) {
			(result.headers || (result.headers = {}))['x-cache'] = [{key: 'X-Cache', value: 'Miss'}];
		}

		return result;
	}

	async onViewerRequest() {
		this.log('→ viewer-request');

		//@ts-expect-error
		this.event.Records[0].cf.config.eventType = 'viewer-request';
		const result = await this.fnSet.viewerRequest(this.event, this.context);

		if (isResponseResult(result)) {
			return this.onViewerResponse(result);
		}

		throw new NoResult();
	}

	async onViewerResponse(result: CloudFrontResponseResult) {
		this.log('← viewer-response');

		//@ts-expect-error
		this.event.Records[0].cf.config.eventType = 'viewer-response';
		const event = combineResult(this.event, result);
		return this.fnSet.viewerResponse(event, this.context);
	}

	private canCache() {
		if (this.options.disableCache) {
			return false;
		}
		const method = this.event.Records[0].cf.request.method;
		return this.fnSet.behavior.cachedMethods.includes(method);
	}

	async onCache() {
		this.log('→ cache');

		if (!this.canCache()) {
			this.log('✗ Cache disabled');
			throw new NoResult();
		}

		const cached = this.fileService.retrieveFromCache(this.event);

		if (!cached) {
			this.log('✗ Cache miss');
			throw new NoResult();
		} else {
			this.log('✓ Cache hit');
		}

		const result = toResultResponse(cached);
		(result.headers || (result.headers = {}))['X-Cache'] = [{key: 'X-Cache', value: 'Hit'}];
		return this.onViewerResponse(result);
	}

	async onOrigin() {
		this.log('→ origin');
		return await this.fnSet.origin.retrieve(this.event);
	}

	async onOriginRequest() {
		this.log('→ origin-request');

		//@ts-expect-error
		this.event.Records[0].cf.config.eventType = 'origin-request';
		const result = await this.fnSet.originRequest(this.event, this.context);

		if (isResponseResult(result)) {
			return result;
		}

		const resultFromOrigin = await this.onOrigin();

		return this.onOriginResponse(resultFromOrigin);
	}

	async onOriginResponse(result: CloudFrontResponseResult) {
		this.log('← origin-response');

		//@ts-expect-error
		this.event.Records[0].cf.config.eventType = 'origin-response';
		const event = combineResult(this.event, result);
		return this.fnSet.originResponse(event, this.context);
	}
}
