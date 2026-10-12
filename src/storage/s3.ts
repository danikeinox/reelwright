import { randomBytes } from "node:crypto";
import { createReadStream, statSync } from "node:fs";
import type { Config } from "../config.js";
import type { StagedMedia } from "./index.js";

type S3Config = NonNullable<Config["storage"]["s3"]>;

function makeClient(s3: S3Config, S3Client: typeof import("@aws-sdk/client-s3").S3Client) {
  return new S3Client({
    region: s3.region,
    ...(s3.endpoint ? { endpoint: s3.endpoint } : {}),
    forcePathStyle: s3.forcePathStyle,
    credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
    // R2 and other S3-compatible stores reject the SDK's newer default checksums
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
}

/** Uploads to the user's own bucket, hands out a short-lived presigned URL and deletes the object afterwards. */
export async function stageViaS3(s3: S3Config, file: string, id: string): Promise<StagedMedia> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = makeClient(s3, S3Client);
  const key = `${s3.prefix}${id}-${randomBytes(6).toString("hex")}.mp4`;

  await client.send(
    new PutObjectCommand({
      Bucket: s3.bucket,
      Key: key,
      Body: createReadStream(file),
      ContentLength: statSync(file).size,
      ContentType: "video/mp4",
    }),
  );
  const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), {
    expiresIn: s3.signedUrlTtlSeconds,
  });
  return {
    url,
    cleanup: async () => {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
      } finally {
        client.destroy();
      }
    },
  };
}

/** Cheap connectivity/permission check used by `doctor`: write, read back through the signed URL, delete. */
export async function checkS3(s3: S3Config): Promise<string> {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
  const client = makeClient(s3, S3Client);
  const key = `${s3.prefix}doctor-${randomBytes(4).toString("hex")}.txt`;
  try {
    await client.send(new PutObjectCommand({ Bucket: s3.bucket, Key: key, Body: "reelwright", ContentType: "text/plain" }));
    const url = await getSignedUrl(client, new GetObjectCommand({ Bucket: s3.bucket, Key: key }), { expiresIn: 60 });
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`signed URL returned HTTP ${res.status}`);
    return "bucket reachable, uploads and signed URLs work";
  } finally {
    try {
      await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: key }));
    } catch {
      /* best effort */
    }
    client.destroy();
  }
}
