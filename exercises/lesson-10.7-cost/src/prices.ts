import { env } from './util';

export const HOURS_PER_MONTH = 730;

export const PRICE = {
	appInstanceHour: env('PRICE_APP_HOUR', 0.192),
	smallInstanceHour: env('PRICE_SMALL_HOUR', 0.096),
	spotShare: env('SPOT_SHARE_OF_ON_DEMAND', 0.35),
	commitDiscount: env('COMMIT_DISCOUNT', 0.35),
	dbInstanceHour: env('PRICE_DB_HOUR', 1.0),
	dbStorageGbMonth: env('PRICE_DB_GB', 0.115),
	backupGbMonth: env('PRICE_BACKUP_GB', 0.095),
	cacheNodeHour: env('PRICE_CACHE_HOUR', 0.2),
	loadBalancerMonth: env('PRICE_LB_MONTH', 100),
	natGatewayHour: env('PRICE_NAT_HOUR', 0.045),
	natPerGb: env('PRICE_NAT_GB', 0.045),
	s3StandardGbMonth: env('PRICE_S3_GB', 0.023),
	s3IaGbMonth: env('PRICE_S3_IA_GB', 0.0125),
	s3IaRetrievalGb: env('PRICE_S3_IA_RETRIEVAL', 0.01),
	s3GlacierIrGbMonth: env('PRICE_S3_GIR_GB', 0.004),
	s3GlacierIrRetrievalGb: env('PRICE_S3_GIR_RETRIEVAL', 0.03),
	s3TransitionIaPer1k: env('PRICE_S3_IA_TRANSITION', 0.01),
	s3TransitionGirPer1k: env('PRICE_S3_GIR_TRANSITION', 0.02),
	s3GetPer1k: env('PRICE_S3_GET', 0.0004),
	s3PutPer1k: env('PRICE_S3_PUT', 0.005),
	internetEgressGb: env('PRICE_EGRESS_GB', 0.09),
	cdnEgressGb: env('PRICE_CDN_GB', 0.085),
	cdnPer10kRequests: env('PRICE_CDN_10K', 0.0075),
	crossAzGbEachWay: env('PRICE_CROSS_AZ_GB', 0.01),
	interfaceEndpointHour: env('PRICE_ENDPOINT_HOUR', 0.01),
	interfaceEndpointGb: env('PRICE_ENDPOINT_GB', 0.01),
	logIngestGb: env('PRICE_LOG_INGEST_GB', 0.5),
	logStoreGbMonth: env('PRICE_LOG_STORE_GB', 0.03),
	metricSeriesMonth: env('PRICE_METRIC_SERIES', 0.03),
	traceIngestGb: env('PRICE_TRACE_GB', 0.1)
} as const;
