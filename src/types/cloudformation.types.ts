export interface CloudFrontDistribution {
	DistributionConfig: CloudFrontDistributionConfig;
}

export interface CloudFrontDistributionConfig {
	CacheBehaviors: CloudFrontCacheBehavior[];
	DefaultCacheBehavior: CloudFrontCacheDefaultBehavior;
	Origins: CloudFrontOrigin[];
}

export interface CloudFrontCacheBehavior {
	AllowedMethods: string[];
	CachedMethods: string[];
	Compress: boolean;
	DefaultTTL: number;
//	ForwardedValues: ForwardedValues,
	MaxTTL: number;
	MinTTL: number;
	TargetOriginId: string;
    ViewerProtocolPolicy: string;
    PathPattern?: string;
}

export interface CloudFrontCacheDefaultBehavior extends CloudFrontCacheBehavior {
	PathPattern?: string;
}

export interface OriginCustomHeader {
	HeaderName: string;
	HeaderValue: string;
}

export interface CloudFrontOrigin {
//	CustomOriginConfig" : CustomOriginConfig,
	DomainName: string;
	Id: string;
	OriginCustomHeaders: OriginCustomHeader[];
	OriginPath: string;
//	S3OriginConfig" : S3OriginConfig
}