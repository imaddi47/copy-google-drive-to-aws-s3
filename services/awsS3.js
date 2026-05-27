import {
  S3Client,
  ListObjectsV2Command,
  HeadObjectCommand,
  GetBucketLocationCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { fromIni, fromEnv } from '@aws-sdk/credential-providers';
import { config, normalizePrefix } from '../config/config.js';

// S3 bucket naming rules: 3-63 chars, lowercase, digits, dots, hyphens.
// Cannot start/end with hyphen or dot, cannot be IPv4-like.
const BUCKET_NAME_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

export const isValidBucketName = (name) => {
  if (typeof name !== 'string') return false;
  if (!BUCKET_NAME_RE.test(name)) return false;
  if (name.includes('..')) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return false;
  return true;
};

export const isChinaRegion = (region) =>
  /^cn-(north|northwest)-\d+$/i.test(region || '');

// Regions per AWS partition. Used by the UI dropdown — the partition is
// inferred from the configured default region, so a China-configured server
// shows only China regions, etc.
const REGIONS_BY_PARTITION = {
  aws: [
    'us-east-1', 'us-east-2', 'us-west-1', 'us-west-2',
    'af-south-1',
    'ap-east-1', 'ap-south-1', 'ap-south-2',
    'ap-northeast-1', 'ap-northeast-2', 'ap-northeast-3',
    'ap-southeast-1', 'ap-southeast-2', 'ap-southeast-3', 'ap-southeast-4', 'ap-southeast-5',
    'ca-central-1', 'ca-west-1',
    'eu-central-1', 'eu-central-2',
    'eu-west-1', 'eu-west-2', 'eu-west-3',
    'eu-north-1', 'eu-south-1', 'eu-south-2',
    'me-south-1', 'me-central-1',
    'sa-east-1',
    'il-central-1',
  ],
  'aws-cn': ['cn-north-1', 'cn-northwest-1'],
  'aws-us-gov': ['us-gov-east-1', 'us-gov-west-1'],
};

export const partitionForRegion = (region) => {
  if (isChinaRegion(region)) return 'aws-cn';
  if (/^us-gov-/i.test(region || '')) return 'aws-us-gov';
  return 'aws';
};

export const listRegionsForConfig = () => {
  const partition = partitionForRegion(config.aws.region);
  return {
    partition,
    default: config.aws.region,
    regions: REGIONS_BY_PARTITION[partition] || REGIONS_BY_PARTITION.aws,
  };
};

// Credentials chain — if the user explicitly set AWS_PROFILE in .env, that
// always wins. Otherwise honour env-style keys, then default profile. This
// reversal (vs. the SDK default) is deliberate: a user who pastes
// AWS_PROFILE=china into .env clearly wants the china profile, even if the
// shell has stale global AWS_ACCESS_KEY_ID exported from another project.
const buildCredentials = () => {
  if (process.env.AWS_PROFILE) {
    return fromIni({ profile: process.env.AWS_PROFILE });
  }
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return fromEnv();
  }
  return fromIni({ profile: 'default' });
};

export const describeCredentialSource = () => {
  if (process.env.AWS_PROFILE) return `profile=${process.env.AWS_PROFILE} (~/.aws/credentials)`;
  if (process.env.AWS_ACCESS_KEY_ID) return 'env vars (AWS_ACCESS_KEY_ID)';
  return 'profile=default (~/.aws/credentials)';
};

// Per-region S3 client cache so cross-region buckets stay efficient.
const clientCache = new Map();

const getClient = (region) => {
  if (!clientCache.has(region)) {
    const opts = {
      region,
      credentials: buildCredentials(),
      followRegionRedirects: true,
    };
    // The AWS China partition (aws-cn) lives on a separate TLD. Pin the
    // endpoint explicitly so we never accidentally hit the global endpoint
    // when the SDK's partition heuristics fall through.
    if (isChinaRegion(region)) {
      opts.endpoint = `https://s3.${region}.amazonaws.com.cn`;
    }
    clientCache.set(region, new S3Client(opts));
  }
  return clientCache.get(region);
};

// Map bucket → region. Discovered lazily via GetBucketLocation or supplied
// explicitly by the caller (e.g. via the @region UI hint).
const bucketRegion = new Map();

export const recordBucketRegion = (bucket, region) => {
  if (bucket && region) bucketRegion.set(bucket, region);
};

const resolveRegion = async (bucket, hint) => {
  if (hint) {
    bucketRegion.set(bucket, hint);
    return hint;
  }
  if (bucketRegion.has(bucket)) return bucketRegion.get(bucket);

  // Probe with the configured default region. If the configured region is
  // already in the China partition, we probe China; otherwise we probe the
  // global partition. Either way, GetBucketLocation returns a constraint
  // we can use to pick the right region.
  const probeRegion = config.aws.region || 'us-east-1';
  try {
    const probe = getClient(probeRegion);
    const res = await probe.send(
      new GetBucketLocationCommand({ Bucket: bucket }),
    );
    const constraint = res.LocationConstraint || 'us-east-1';
    // Historic AWS API quirks: 'EU' means eu-west-1; '' means us-east-1.
    const region = constraint === 'EU' ? 'eu-west-1' : constraint;
    bucketRegion.set(bucket, region);
    return region;
  } catch (err) {
    // GetBucketLocation may be denied by IAM or fail across partitions.
    // Fall back to the configured region. If the user is on a China profile
    // the configured region will be cn-*, which is what they want.
    console.warn(
      `resolveRegion(${bucket}) probe failed (${err.message}); using configured region ${probeRegion}`,
    );
    return probeRegion;
  }
};

const clientFor = async (bucket, regionHint) => {
  const target = bucket || config.aws.bucket;
  if (!target) {
    throw new Error('No S3 bucket specified and no default S3_BUCKET configured');
  }
  if (!isValidBucketName(target)) {
    throw new Error(`Invalid S3 bucket name: ${target}`);
  }
  const region = await resolveRegion(target, regionHint);
  return { client: getClient(region), bucket: target, region };
};

export const listObjects = async ({
  bucket,
  region,
  prefix,
  continuationToken,
} = {}) => {
  const { client, bucket: resolvedBucket, region: resolvedRegion } = await clientFor(
    bucket,
    region,
  );
  const cmd = new ListObjectsV2Command({
    Bucket: resolvedBucket,
    Prefix: normalizePrefix(prefix),
    Delimiter: '/',
    ContinuationToken: continuationToken,
    MaxKeys: 1000,
  });
  const res = await client.send(cmd);
  return {
    bucket: resolvedBucket,
    region: resolvedRegion,
    folders: (res.CommonPrefixes || []).map((p) => p.Prefix),
    files: (res.Contents || [])
      .filter((o) => o.Key !== normalizePrefix(prefix))
      .map((o) => ({
        key: o.Key,
        size: o.Size,
        lastModified: o.LastModified,
      })),
    nextContinuationToken: res.NextContinuationToken,
  };
};

export const objectExists = async ({ bucket, region, key }) => {
  const { client, bucket: resolvedBucket } = await clientFor(bucket, region);
  try {
    await client.send(
      new HeadObjectCommand({ Bucket: resolvedBucket, Key: key }),
    );
    return true;
  } catch (err) {
    if (err.$metadata?.httpStatusCode === 404 || err.name === 'NotFound') {
      return false;
    }
    throw err;
  }
};

export const deleteObject = async ({ bucket, region, key }) => {
  if (!key || typeof key !== 'string') {
    throw new Error('object key is required');
  }
  const { client, bucket: resolvedBucket } = await clientFor(bucket, region);
  await client.send(
    new DeleteObjectCommand({ Bucket: resolvedBucket, Key: key }),
  );
  return { bucket: resolvedBucket, key };
};

// Bulk delete — chunks into the S3 1000-key-per-request limit and returns
// per-key success/error breakdown so the UI can surface partial failures.
export const deleteObjects = async ({ bucket, region, keys }) => {
  if (!Array.isArray(keys) || keys.length === 0) {
    throw new Error('keys array is required');
  }
  const { client, bucket: resolvedBucket } = await clientFor(bucket, region);
  const deleted = [];
  const errors = [];
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    const res = await client.send(
      new DeleteObjectsCommand({
        Bucket: resolvedBucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: false,
        },
      }),
    );
    if (res.Deleted) {
      for (const d of res.Deleted) deleted.push(d.Key);
    }
    if (res.Errors) {
      for (const e of res.Errors) {
        errors.push({ key: e.Key, code: e.Code, message: e.Message });
      }
    }
  }
  return { bucket: resolvedBucket, deleted, errors };
};

export const uploadStream = async ({
  bucket,
  region,
  key,
  body,
  contentType,
  onProgress,
}) => {
  const { client, bucket: resolvedBucket } = await clientFor(bucket, region);
  const upload = new Upload({
    client,
    params: {
      Bucket: resolvedBucket,
      Key: key,
      Body: body,
      ContentType: contentType,
    },
    queueSize: 4,
    partSize: 1024 * 1024 * 8,
    leavePartsOnError: false,
  });
  if (typeof onProgress === 'function') {
    upload.on('httpUploadProgress', onProgress);
  }
  return upload.done();
};
