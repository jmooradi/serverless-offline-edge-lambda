import { Context } from 'aws-lambda';
import bodyParser from 'body-parser';
import connect, { HandleFunction } from 'connect';
import cookieParser from 'cookie-parser';
import * as fs from 'fs-extra';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { createServer as createServerSecure } from 'https';
import { HttpError, InternalServerError } from './errors/http';
import { StatusCodes } from 'http-status-codes';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';

import { FunctionSet } from './function-set';
import { asyncMiddleware, cloudfrontPost } from './middlewares';
import { CloudFrontLifecycle, Origin, CacheService } from './services';
import { ServerlessInstance, ServerlessOptions } from './types';
import {
	buildConfig, buildContext, CloudFrontHeadersHelper, ConfigBuilder,
	convertToCloudFrontEvent, IncomingMessageWithBodyAndCookies
} from './utils';

import  { CloudFrontCacheBehavior, CloudFrontOrigin } from './types/cloudformation.types';

interface OriginMapping {
	Id: string;
	target: string;
	default?: boolean;
}

export class BehaviorRouter {
	private builder: ConfigBuilder;
	private context: Context;
	private behaviors = new Map<string, FunctionSet>();

	private cacheDir: string;
	private fileDir: string;
	private path: string;

	private origins: Map<string, Origin>;

	private cacheService: CacheService;
	private log: (message: string) => void;

	public buildingPromise: Promise<void>;

	constructor(
		private serverless: ServerlessInstance,
		private options: ServerlessOptions
	) {
		this.log = serverless.cli.log.bind(serverless.cli);

		this.builder = buildConfig(serverless);
		this.context = buildContext();

		const offlineEdgeLambda = this.serverless.service.custom.offlineEdgeLambda;

		this.cacheDir = path.resolve(options.cacheDir || offlineEdgeLambda.cacheDir || path.join(os.tmpdir(), 'edge-lambda'));
		this.fileDir = path.resolve(options.fileDir || offlineEdgeLambda.fileDir || path.join(os.tmpdir(), 'edge-lambda'));
		this.path = offlineEdgeLambda.path || '';

		fs.mkdirpSync(this.cacheDir);
		fs.mkdirpSync(this.fileDir);

		this.origins = new Map<string, Origin>();
		this.cacheService = new CacheService(this.cacheDir);

		this.buildingPromise = Promise.resolve();
	}

	match(req: IncomingMessage): FunctionSet | null {
		if (!req.url) {
			return null;
		}

		const url = new URL(req.url, 'http://localhost');

		for (const [, handler] of this.behaviors) {
			if (handler.regex.test(url.pathname)) {
				return handler;
			}
		}

		return this.behaviors.get('*') || null;
	}

	async listen(port: number) {
		try {
			await this.extractBehaviors();
			this.logStorage();
			this.logBehaviors();

			const app = connect();

			app.use(cloudfrontPost());
			app.use(bodyParser());
			app.use(cookieParser() as HandleFunction);
			app.use(asyncMiddleware(async (req: IncomingMessageWithBodyAndCookies, res: ServerResponse) => {
				if ((req.method || '').toUpperCase() === 'PURGE') {
					await this.purgeStorage();

					res.statusCode = StatusCodes.OK;
					res.end();
					return;
				}

				const handler = this.match(req);
				const cfEvent = convertToCloudFrontEvent(req, this.builder('viewer-request'));

				if (!handler) {
					res.statusCode = StatusCodes.NOT_FOUND;
					res.end();
					return;
				}

				try {
					const lifecycle = new CloudFrontLifecycle(this.serverless, this.options, cfEvent, this.context, this.cacheService, handler);
					const response = await this.buildingPromise.then(() => lifecycle.run(req.url as string));

					if (!response) {
						throw new InternalServerError('No response set after full request lifecycle');
					}

					res.statusCode = parseInt(response.status, 10);
					res.statusMessage = response.statusDescription || '';

					const helper = new CloudFrontHeadersHelper(response.headers);

					for (const { key, value } of helper.asHttpHeaders()) {
						if (value) {
							res.setHeader(key as string, value);
						}
					}

					res.end(response.body);
				} catch (err) {
					this.handleError(err, res);
					return;
				}
			}));


			return new Promise(resolve => {
				let server;
				if (Number(port) === 443 || Number(port) === 444) {
					server = createServerSecure({
						key: fs.readFileSync(__dirname + '/../cert/key.pem'),
						cert: fs.readFileSync(__dirname + '/../cert/cert.pem')
					}, app);
				} else {
					server = createServer(app);
				}

				server.listen(Number(port));
				server.on('close', resolve);
			});
		} catch (err) {
			console.error(err);
			process.exit(1);
		}
	}

	public handleError(err: HttpError, res: ServerResponse) {
		res.statusCode = err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;

		const payload = JSON.stringify(err.hasOwnProperty('getResponsePayload') ?
			err.getResponsePayload() :
			{
				code: StatusCodes.INTERNAL_SERVER_ERROR,
				message: err.stack || err.message
			}
		);

		res.end(payload);
	}

	public async purgeStorage() {
		this.cacheService.purge();
	}

	private configureOrigins(): Map<string, Origin> {
		const { custom, resources } = this.serverless.service;
		const mappings = resources?.Resources?.CloudFrontDistribution?.Properties?.DistributionConfig?.Origins || [];
		const originMaps: OriginMapping[] = custom.offlineEdgeLambda.originMap || [];

		return mappings.reduce((acc: Map<string, Origin>, item: CloudFrontOrigin) => {
			const baseUrl = originMaps.find(({ Id }) => Id == item.Id)?.target;
			acc.set(item.Id, new Origin(item, baseUrl && item.OriginPath ? path.join(baseUrl, item.OriginPath) : baseUrl));
			return acc;
		}, new Map<string, Origin>());
	}

	private async extractBehaviors() {
		const { functions, resources } = this.serverless.service;

		this.origins = this.configureOrigins();

		const behaviors = this.behaviors;

		behaviors.clear();

		const eventFunctions = Object.entries(functions)
			.filter(([, fn]) => 'events' in fn && Array.isArray(fn.events) && fn.events.length);

		const cloudfrontConfig = resources?.Resources?.CloudFrontDistribution?.Properties?.DistributionConfig;
		const cloudfrontBehaviors: CloudFrontCacheBehavior[] = [];
		
		if (cloudfrontConfig) {
			if (cloudfrontConfig.CacheBehaviors) {
				cloudfrontBehaviors.push(...cloudfrontConfig.CacheBehaviors);
			}
			cloudfrontBehaviors.push(cloudfrontConfig.DefaultCacheBehavior);
		}

		for await (const [, fn] of eventFunctions) {

			const cloudfrontEvents = fn.events.filter(evt => 'cloudFront' in evt);

			for await (const event of cloudfrontEvents) {
			
				const lambdaAtEdge = event.cloudFront;

				const pattern = lambdaAtEdge.pathPattern || '*';

				if (!behaviors.has(pattern)) {
					const origin = this.origins.get(lambdaAtEdge.origin.Id);
					const behavior = cloudfrontBehaviors.find(b => b.TargetOriginId === lambdaAtEdge.origin.Id);
					behaviors.set(pattern, new FunctionSet(pattern, this.log, origin, lambdaAtEdge.origin.Id, behavior));
				}

				const fnSet = behaviors.get(pattern) as FunctionSet;

				await fnSet.setHandler(lambdaAtEdge.eventType, path.join(this.path, fn.handler));
			}
		}

		if (!behaviors.has('*')) {
			behaviors.set('*', new FunctionSet('*', this.log, this.origins.get('*')));
		}
	}

	public async reloadBehaviors() {
		await this.extractBehaviors();
	}

	private logStorage() {
		this.log(`Cache directory: file://${this.cacheDir}`);
		this.log(`Files directory: file://${this.fileDir}`);
		console.log();
	}

	private logBehaviors() {
		this.behaviors.forEach((behavior, key) => {
			this.log(`Lambdas for path pattern ${key}: `);

			behavior.viewerRequest && this.log(`viewer-request => ${behavior.viewerRequest.path || ''}`);
			behavior.originRequest && this.log(`origin-request => ${behavior.originRequest.path || ''}`);
			behavior.originResponse && this.log(`origin-response => ${behavior.originResponse.path || ''}`);
			behavior.viewerResponse && this.log(`viewer-response => ${behavior.viewerResponse.path || ''}`);

			console.log(); // New line
		});
	}
}
