import axios from 'axios';
import { parseStringPromise } from 'xml2js';

interface PlexClientOptions {
  hostname: string;
  port?: number;
  https?: boolean;
  timeout?: number;
  token?: string;
  options: {
    identifier: string;
    product: string;
    deviceName: string;
    platform: string;
  };
}

type PlexRequest =
  | string
  | { uri: string; extraHeaders?: Record<string, string | number> };

class PlexHttpError extends Error {
  constructor(message: string, readonly statusCode?: number, code?: string) {
    super(message);
    if (code) (this as { code?: string }).code = code;
  }
}

const parseBody = async (
  contentType: string | undefined,
  body: Buffer
): Promise<unknown> => {
  if (contentType === 'application/json') {
    return JSON.parse(body.toString('utf8'));
  }
  if (!contentType) {
    return body.toString('utf8');
  }
  if (contentType.indexOf('xml') > -1) {
    return parseStringPromise(body.toString('utf8'), { attrkey: 'attributes' });
  }
  return body;
};

export default class PlexClient {
  private readonly baseUrl: string;
  private readonly timeout?: number;
  private readonly token?: string;
  private readonly identity: PlexClientOptions['options'];

  constructor(opts: PlexClientOptions) {
    if (typeof opts.hostname !== 'string') {
      throw new TypeError('Invalid Plex Server hostname');
    }
    const port = opts.port || 32400;
    const secure = opts.https !== undefined ? !!opts.https : port === 443;
    this.baseUrl = `${secure ? 'https://' : 'http://'}${opts.hostname}:${port}`;
    this.timeout = opts.timeout;
    this.token = opts.token;
    this.identity = opts.options;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query<T extends Record<string, any>>(request: PlexRequest): Promise<T> {
    return this.send('GET', request, true) as Promise<T>;
  }

  postQuery(request: PlexRequest): Promise<unknown> {
    return this.send('POST', request, true);
  }

  putQuery(request: PlexRequest): Promise<unknown> {
    return this.send('PUT', request, true);
  }

  deleteQuery(request: PlexRequest): Promise<void> {
    return this.send('DELETE', request, false) as Promise<void>;
  }

  private async send(
    method: string,
    request: PlexRequest,
    parse: boolean
  ): Promise<unknown> {
    const { uri, extraHeaders } =
      typeof request === 'string'
        ? { uri: request, extraHeaders: {} }
        : request;
    if (uri === undefined) {
      throw new TypeError('Requires uri parameter');
    }

    const headers: Record<string, string> = { Accept: 'application/json' };
    if (typeof this.token === 'string') headers['X-Plex-Token'] = this.token;
    for (const [key, value] of Object.entries(extraHeaders ?? {})) {
      if (typeof value === 'string') headers[key] = value;
    }
    Object.assign(headers, {
      'X-Plex-Client-Identifier': this.identity.identifier,
      'X-Plex-Product': this.identity.product,
      'X-Plex-Version': '1.0',
      'X-Plex-Device': process.platform,
      'X-Plex-Device-Name': this.identity.deviceName,
      'X-Plex-Platform': this.identity.platform,
      'X-Plex-Platform-Version': process.version,
      'X-Plex-Provides': 'controller',
    });

    let response;
    try {
      response = await axios.request<Buffer>({
        url: this.baseUrl + uri,
        method,
        headers,
        timeout: this.timeout,
        responseType: 'arraybuffer',
        validateStatus: () => true,
        maxRedirects: 10,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        transformResponse: (data) => data,
      });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      if (err.code === 'ECONNABORTED') {
        throw new PlexHttpError(
          'ESOCKETTIMEDOUT',
          undefined,
          'ESOCKETTIMEDOUT'
        );
      }
      throw e;
    }

    const status = response.status;
    if (status === 403) {
      throw new PlexHttpError(
        'Plex Server denied request due to lack of managed user permissions! ' +
          'In case of a delete request, delete content mustbe  allowed in plex-media-server options.',
        status
      );
    }
    if (status === 401) {
      throw new PlexHttpError(
        this.token
          ? 'Permission denied even after attempted authentication :( Wrong username and/or password maybe?'
          : 'Authentication failed, reason: Plex Token not found!',
        status
      );
    }
    if (status < 200 || status > 299) {
      throw new PlexHttpError(
        'Plex Server didnt respond with a valid 2xx status code, response code: ' +
          status,
        status
      );
    }

    if (!parse) return undefined;
    return parseBody(
      response.headers['content-type'] as string | undefined,
      Buffer.from(response.data)
    );
  }
}
