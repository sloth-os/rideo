/**
 * Type declarations for the subset of @sloth-os/mm-gateway-js (OpenAPI-generated, untyped CommonJS)
 * that Rideo uses. Request bodies are the gateway's snake_case wire objects (see @rideo/shared gateway types).
 */
declare module '@sloth-os/mm-gateway-js' {
  export interface SdkResponse {
    status: number;
    headers: Record<string, string | undefined>;
    body: unknown;
    text?: string;
  }

  export interface HttpInfo<T> {
    data: T;
    response: SdkResponse;
  }

  /** Rejection shape of ApiClient.callApi. */
  export interface SdkError {
    status?: number;
    statusText?: string;
    body?: unknown;
    response?: SdkResponse;
    error?: Error;
  }

  export interface SdkTask {
    id: string;
    object?: string;
    model: string;
    status: string;
    outputs?: { uri: string; mime_type?: string; cover_uri?: string; revised_prompt?: string }[];
    usage?: Record<string, number>;
    metadata?: Record<string, unknown>;
    error?: { code: string; message: string } | null;
    lyrics?: string;
    created_at: string | Date;
    completed_at?: string | Date | null;
    links: { self: string };
  }

  export interface SdkModelEntry {
    id: string;
    object?: string;
    modality: 'image' | 'video' | 'music';
    limits?: Record<string, unknown>;
  }

  export class ApiClient {
    constructor(basePath?: string);
    basePath: string;
    authentications: { BearerAuth: { type: 'bearer'; accessToken?: string | (() => string) } };
    defaultHeaders: Record<string, string>;
    timeout: number;
    cache: boolean;
  }

  interface GetOpts {
    ifNoneMatch?: string;
  }
  interface CreateOpts {
    idempotencyKey?: string;
  }

  export class ImagesApi {
    constructor(client?: ApiClient);
    createImage(body: object, opts?: CreateOpts): Promise<SdkTask>;
    createImageWithHttpInfo(body: object, opts?: CreateOpts): Promise<HttpInfo<SdkTask>>;
    getImage(id: string, opts?: GetOpts): Promise<SdkTask>;
    getImageWithHttpInfo(id: string, opts?: GetOpts): Promise<HttpInfo<SdkTask>>;
  }

  export class VideosApi {
    constructor(client?: ApiClient);
    createVideo(body: object, opts?: CreateOpts): Promise<SdkTask>;
    createVideoWithHttpInfo(body: object, opts?: CreateOpts): Promise<HttpInfo<SdkTask>>;
    getVideo(id: string, opts?: GetOpts): Promise<SdkTask>;
    getVideoWithHttpInfo(id: string, opts?: GetOpts): Promise<HttpInfo<SdkTask>>;
  }

  export class MusicApi {
    constructor(client?: ApiClient);
    createMusic(body: object, opts?: CreateOpts): Promise<SdkTask>;
    createMusicWithHttpInfo(body: object, opts?: CreateOpts): Promise<HttpInfo<SdkTask>>;
    getMusic(id: string, opts?: GetOpts): Promise<SdkTask>;
    getMusicWithHttpInfo(id: string, opts?: GetOpts): Promise<HttpInfo<SdkTask>>;
  }

  export class MetaApi {
    constructor(client?: ApiClient);
    getHealth(): Promise<{ status: string }>;
    listModels(opts?: { modality?: string }): Promise<{ object: string; data: SdkModelEntry[] }>;
    listModelLimits(opts?: { modality?: string }): Promise<{ object: string; data: SdkModelEntry[] }>;
  }

  const sdk: {
    ApiClient: typeof ApiClient;
    ImagesApi: typeof ImagesApi;
    VideosApi: typeof VideosApi;
    MusicApi: typeof MusicApi;
    MetaApi: typeof MetaApi;
  };
  export default sdk;
}
