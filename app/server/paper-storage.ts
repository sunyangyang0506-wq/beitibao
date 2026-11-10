import OSS from 'ali-oss';
import { createHmac } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';

export const maxImageBytes = 10 * 1024 * 1024;
export const maxPrivatePdfBytes = 50 * 1024 * 1024;
export const objectVersionPattern = '^[A-Za-z0-9._~+=/-]{1,256}$';
const versionFormat = new RegExp(objectVersionPattern);
const keyFormat = /^papers\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/;
const region = 'cn-beijing';
const hmac = (key: string | Buffer, value: string) => createHmac('sha256', key).update(value).digest();

type StorageCredentials = { accessKeyId: string; accessKeySecret: string; stsToken: string };
export type PaperMediaType = 'application/pdf' | 'image/jpeg' | 'image/png';
export type PaperObject = { key: string; version: string; bytes: number; mediaType: PaperMediaType };
export type PaperOriginal = {
  pdf: Buffer | null;
  object_key: string | null;
  object_version: string | null;
  object_bytes: number | null;
  media_type: string;
};
export type PaperUploadForm = { url: string; fields: Record<string, string> };
export type PaperStorage = {
  signUpload(key: string, mediaType: PaperMediaType, bytes: number, expires: Date): PaperUploadForm;
  read(object: PaperObject): Promise<Buffer | null>;
};
type ListedVersion = { name: string; versionId: string };
type OssVersionClient = OSS & {
  listObjectVersions(query: { prefix: string; maxKeys: number }): Promise<{
    objects: ListedVersion[]; deleteMarker: ListedVersion[]; isTruncated: boolean;
  }>;
  delete(name: string, options: { versionId: string }): Promise<OSS.DeleteResult>;
};

export function paperObjectKey(tenant: string, upload: string) {
  return `papers/${tenant}/${upload}`;
}

export function cloudCredentials(headers: IncomingHttpHeaders): StorageCredentials {
  const fromFunction = process.env.FC_REGION === region && typeof headers['x-fc-request-id'] === 'string';
  const accessKeyId = fromFunction ? headers['x-fc-access-key-id'] : process.env.ALIBABA_CLOUD_ACCESS_KEY_ID;
  const accessKeySecret = fromFunction ? headers['x-fc-access-key-secret'] : process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET;
  const stsToken = fromFunction ? headers['x-fc-security-token'] : process.env.ALIBABA_CLOUD_SECURITY_TOKEN;
  if (typeof accessKeyId !== 'string' || !accessKeyId || typeof accessKeySecret !== 'string' || !accessKeySecret ||
      typeof stsToken !== 'string' || !stsToken) throw new Error('OSS_TEMPORARY_CREDENTIALS_REQUIRED');
  return { accessKeyId, accessKeySecret, stsToken };
}

export function ossPaperStorage(bucket: string, headers: IncomingHttpHeaders = {}, now = () => new Date()):
PaperStorage & { purge(key: string, keptVersion: string | null): Promise<boolean> } {
  if (!/^beitibao-(staging|production)-[a-z0-9]{6,12}-papers$/.test(bucket)) {
    throw new Error('INVALID_PRIVATE_PAPER_BUCKET');
  }
  const endpoint = `https://oss-${region}-internal.aliyuncs.com`;
  const uploadUrl = `https://${bucket}.oss-${region}.aliyuncs.com/`;
  const versionClient = () => new OSS({ ...cloudCredentials(headers), bucket, endpoint, region: `oss-${region}`,
    authorizationV4: true, timeout: 15_000 }) as OssVersionClient;
  return {
    signUpload(key, mediaType, bytes, expires) {
      const credentials = cloudCredentials(headers);
      const date = now().toISOString().replace(/[-:]|\.\d{3}/g, '');
      const day = date.slice(0, 8);
      if (!keyFormat.test(key)) throw new Error('INVALID_PAPER_OBJECT_KEY');
      const scope = [day, region, 'oss', 'aliyun_v4_request'];
      const fields = {
        key, 'content-type': mediaType, success_action_status: '201',
        'x-oss-signature-version': 'OSS4-HMAC-SHA256',
        'x-oss-credential': [credentials.accessKeyId, ...scope].join('/'),
        'x-oss-date': date, 'x-oss-security-token': credentials.stsToken,
        'x-oss-server-side-encryption': 'AES256'
      };
      const policy = Buffer.from(JSON.stringify({ expiration: expires.toISOString(), conditions: [
        { bucket }, ...Object.entries(fields).map(([name, value]) => ({ [name]: value })),
        ['content-length-range', bytes, bytes]
      ] })).toString('base64');
      const signingKey = scope.reduce((key, part) => hmac(key, part), Buffer.from('aliyun_v4' + credentials.accessKeySecret));
      return { url: uploadUrl, fields: { ...fields, policy, 'x-oss-signature': hmac(signingKey, policy).toString('hex') } };
    },
    async read(object) {
      if (!keyFormat.test(object.key) || !versionFormat.test(object.version) || object.version === 'null') {
        throw new Error('INVALID_PAPER_OBJECT_VERSION');
      }
      const client = versionClient();
      const url = await client.signatureUrlV4('GET', 60, { queries: { versionId: object.version } }, object.key);
      const result = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      if (!result.ok || !result.body || result.headers.get('x-oss-version-id') !== object.version ||
          Number(result.headers.get('content-length')) !== object.bytes || result.headers.get('content-type') !== object.mediaType) {
        await result.body?.cancel();
        if (!result.ok && result.status !== 404) throw new Error('OSS_READ_UNAVAILABLE');
        return null;
      }
      const body = Buffer.alloc(object.bytes);
      const reader = result.body.getReader();
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return length === body.length ? body : null;
          if (length + value.length > body.length) return null;
          body.set(value, length);
          length += value.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    },
    async purge(key, keptVersion) {
      if (!keyFormat.test(key)) throw new Error('INVALID_PAPER_OBJECT_KEY');
      const client = versionClient();
      const { objects, deleteMarker, isTruncated } = await client.listObjectVersions({ prefix: key, maxKeys: 20 });
      const unused = [...objects, ...deleteMarker].filter(item => item.name === key && item.versionId !== keptVersion);
      for (let i = 0; i < unused.length; i += 5) {
        await Promise.all(unused.slice(i, i + 5).map(async item => {
          if (!versionFormat.test(item.versionId)) throw new Error('INVALID_PAPER_OBJECT_VERSION');
          const deleted = await client.delete(key, { versionId: item.versionId });
          if (deleted.res.status !== 204) throw new Error('OSS_DELETE_UNAVAILABLE');
        }));
      }
      return !isTruncated;
    }
  };
}

export async function loadPaperOriginal(source: PaperOriginal, storage?: PaperStorage) {
  if (!source.object_key && source.pdf?.length) return source.pdf;
  if (storage && source.object_key && source.object_version && source.object_bytes) {
    const bytes = await storage.read({ key: source.object_key, version: source.object_version,
      bytes: source.object_bytes, mediaType: source.media_type as PaperMediaType });
    if (bytes) return bytes;
  }
  throw new Error('PAPER_ORIGINAL_UNAVAILABLE');
}
