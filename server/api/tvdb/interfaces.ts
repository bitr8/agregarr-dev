export interface TvdbLoginResponse {
  data: {
    token: string;
  };
}

export interface TvdbSeriesStatus {
  id: number;
  name: string;
  recordType: string;
  keepUpdated: boolean;
}

export interface TvdbSeriesData {
  id: number;
  name: string;
  status: TvdbSeriesStatus;
  lastAired: string | null;
}

export interface TvdbSeriesResponse {
  data: TvdbSeriesData;
}

export interface TvdbRemoteId {
  id: string;
  type: number;
  sourceName: string;
}

export interface TvdbListEntity {
  order: number;
  seriesId: number | null;
  movieId: number | null;
}

export interface TvdbListBase {
  id: number;
  name: string;
  url: string;
  isOfficial: boolean;
}

export interface TvdbListExtended extends TvdbListBase {
  entities: TvdbListEntity[] | null;
}

export interface TvdbRemoteIdsRecord {
  id: number;
  name: string;
  year?: string;
  remoteIds: TvdbRemoteId[] | null;
}

export interface TvdbDataResponse<T> {
  status: string;
  data: T;
}
