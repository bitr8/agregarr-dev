export interface CollectionPreset {
  id: string;
  name: string;
  description: string;
  mediaType: 'movie' | 'tv';
  config: {
    type: string;
    subtype: string;
    template: string;
    maxItems: number;
    visibilityConfig: {
      usersHome: boolean;
      serverOwnerHome: boolean;
      libraryRecommended: boolean;
    };
    networksCountry?: string;
  };
}

export const COLLECTION_PRESETS: CollectionPreset[] = [
  {
    id: 'tmdb-trending-today-movies',
    name: 'Trending Movies Today',
    description: 'Currently trending movies from TMDB',
    mediaType: 'movie',
    config: {
      type: 'tmdb',
      subtype: 'trending_day',
      template: 'Trending {mediaType}s Today',
      maxItems: 20,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'tmdb-trending-today-tv',
    name: 'Trending TV Today',
    description: 'Currently trending TV shows from TMDB',
    mediaType: 'tv',
    config: {
      type: 'tmdb',
      subtype: 'trending_day',
      template: 'Trending {mediaType}s Today',
      maxItems: 20,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'tmdb-top-rated-movies',
    name: 'TMDB Top Rated Movies',
    description: 'Highest rated movies of all time on TMDB',
    mediaType: 'movie',
    config: {
      type: 'tmdb',
      subtype: 'top_rated',
      template: 'Top Rated {mediaType}s',
      maxItems: 50,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'tmdb-top-rated-tv',
    name: 'TMDB Top Rated TV',
    description: 'Highest rated TV shows of all time on TMDB',
    mediaType: 'tv',
    config: {
      type: 'tmdb',
      subtype: 'top_rated',
      template: 'Top Rated {mediaType}s',
      maxItems: 50,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'imdb-top-250',
    name: 'IMDb Top 250',
    description: 'The IMDb Top 250 movies list',
    mediaType: 'movie',
    config: {
      type: 'imdb',
      subtype: 'top_250',
      template: 'IMDb Top 250',
      maxItems: 250,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'imdb-popular-movies',
    name: 'IMDb Most Popular Movies',
    description: 'Currently most popular movies on IMDb',
    mediaType: 'movie',
    config: {
      type: 'imdb',
      subtype: 'popular',
      template: 'IMDb Popular {mediaType}s',
      maxItems: 30,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'imdb-popular-tv',
    name: 'IMDb Most Popular TV',
    description: 'Currently most popular TV shows on IMDb',
    mediaType: 'tv',
    config: {
      type: 'imdb',
      subtype: 'popular',
      template: 'IMDb Popular {mediaType}s',
      maxItems: 30,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'upcoming-movies',
    name: 'Upcoming Movies',
    description: 'Most anticipated upcoming movie releases',
    mediaType: 'movie',
    config: {
      type: 'comingsoon',
      subtype: 'tmdb_anticipated',
      template: 'Upcoming {mediaType}s',
      maxItems: 30,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'upcoming-tv',
    name: 'Upcoming TV',
    description: 'Most anticipated upcoming TV shows',
    mediaType: 'tv',
    config: {
      type: 'comingsoon',
      subtype: 'tmdb_anticipated',
      template: 'Upcoming {mediaType}s',
      maxItems: 30,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'trakt-trending-movies',
    name: 'Trakt Trending Movies',
    description: 'Movies trending right now on Trakt (requires Trakt API key)',
    mediaType: 'movie',
    config: {
      type: 'trakt',
      subtype: 'trending',
      template: 'Trending {mediaType}s',
      maxItems: 20,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'trakt-trending-tv',
    name: 'Trakt Trending TV',
    description:
      'TV shows trending right now on Trakt (requires Trakt API key)',
    mediaType: 'tv',
    config: {
      type: 'trakt',
      subtype: 'trending',
      template: 'Trending {mediaType}s',
      maxItems: 20,
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
  {
    id: 'netflix-top-10-movies',
    name: 'Netflix Top 10 Movies',
    description: 'Global Netflix Top 10 movies (scraped from FlixPatrol)',
    mediaType: 'movie',
    config: {
      type: 'networks',
      subtype: 'netflix_top_10',
      template: 'Netflix Top 10 {mediaType}s',
      maxItems: 10,
      networksCountry: 'global',
      visibilityConfig: {
        usersHome: false,
        serverOwnerHome: true,
        libraryRecommended: true,
      },
    },
  },
];
