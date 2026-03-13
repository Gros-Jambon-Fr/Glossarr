'use strict';

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const LANGUAGE              = process.env.LANGUAGE                     || 'fra';
const TVDB_API_KEY          = process.env.TVDB_API_KEY;
const TMDB_API_KEY          = process.env.TMDB_API_KEY;
const PRIMARY_SOURCE        = process.env.PRIMARY_TRANSLATION_SOURCE   || 'tvdb';
const SECONDARY_SOURCE      = process.env.SECONDARY_TRANSLATION_SOURCE || null;
const SHOW_TITLE_MODE       = process.env.SHOW_TITLE_MODE              || 'native';
const SHOW_OVERVIEW_MODE    = process.env.SHOW_OVERVIEW_MODE           || 'always';
const SEASON_TITLE_MODE     = process.env.SEASON_TITLE_MODE            || 'native';
const SEASON_OVERVIEW_MODE  = process.env.SEASON_OVERVIEW_MODE         || 'always';
const EPISODE_TITLE_MODE    = process.env.EPISODE_TITLE_MODE           || 'native';
const EPISODE_OVERVIEW_MODE = process.env.EPISODE_OVERVIEW_MODE        || 'always';
const CERT_DIR              = process.env.CERT_DIR;

const PORT_HTTP  = 3000;
const PORT_HTTPS = parseInt(process.env.GLOSSARR_PORT, 10) || 3443;

const needsTvdb = PRIMARY_SOURCE === 'tvdb' || SECONDARY_SOURCE === 'tvdb';
const needsTmdb = PRIMARY_SOURCE === 'tmdb' || SECONDARY_SOURCE === 'tmdb';

if (needsTvdb && !TVDB_API_KEY) {
  console.error('TVDB_API_KEY is required when TRANSLATION_SOURCE includes tvdb');
  process.exit(1);
}
if (needsTmdb && !TMDB_API_KEY) {
  console.error('TMDB_API_KEY is required when TRANSLATION_SOURCE includes tmdb');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Mapping ISO 639-2 (TVDB/LANGUAGE) → locale TMDB + ISO 639-1
// ---------------------------------------------------------------------------

const LANG_MAP = {
  ara: { tmdbLocale: 'ar-SA', iso1: 'ar' },
  bul: { tmdbLocale: 'bg-BG', iso1: 'bg' },
  ces: { tmdbLocale: 'cs-CZ', iso1: 'cs' },
  dan: { tmdbLocale: 'da-DK', iso1: 'da' },
  deu: { tmdbLocale: 'de-DE', iso1: 'de' },
  ell: { tmdbLocale: 'el-GR', iso1: 'el' },
  eng: { tmdbLocale: 'en-US', iso1: 'en' },
  fin: { tmdbLocale: 'fi-FI', iso1: 'fi' },
  fra: { tmdbLocale: 'fr-FR', iso1: 'fr' },
  hun: { tmdbLocale: 'hu-HU', iso1: 'hu' },
  ind: { tmdbLocale: 'id-ID', iso1: 'id' },
  ita: { tmdbLocale: 'it-IT', iso1: 'it' },
  jpn: { tmdbLocale: 'ja-JP', iso1: 'ja' },
  kor: { tmdbLocale: 'ko-KR', iso1: 'ko' },
  nld: { tmdbLocale: 'nl-NL', iso1: 'nl' },
  nor: { tmdbLocale: 'nb-NO', iso1: 'nb' },
  pol: { tmdbLocale: 'pl-PL', iso1: 'pl' },
  por: { tmdbLocale: 'pt-PT', iso1: 'pt' },
  ron: { tmdbLocale: 'ro-RO', iso1: 'ro' },
  rus: { tmdbLocale: 'ru-RU', iso1: 'ru' },
  spa: { tmdbLocale: 'es-ES', iso1: 'es' },
  swe: { tmdbLocale: 'sv-SE', iso1: 'sv' },
  tha: { tmdbLocale: 'th-TH', iso1: 'th' },
  tur: { tmdbLocale: 'tr-TR', iso1: 'tr' },
  ukr: { tmdbLocale: 'uk-UA', iso1: 'uk' },
  vie: { tmdbLocale: 'vi-VN', iso1: 'vi' },
  zho: { tmdbLocale: 'zh-CN', iso1: 'zh' },
};

const tmdbLocale = LANG_MAP[LANGUAGE]?.tmdbLocale ?? `${LANGUAGE.slice(0, 2)}-${LANGUAGE.slice(0, 2).toUpperCase()}`;
const langIso1   = LANG_MAP[LANGUAGE]?.iso1       ?? LANGUAGE.slice(0, 2);

// ---------------------------------------------------------------------------
// TVDB — authentification et cache du token JWT (valide ~1 mois, on rafraîchit à 23h)
// ---------------------------------------------------------------------------

let tvdbToken       = null;
let tvdbTokenExpiry = 0;

async function getTvdbToken() {
  if (tvdbToken && Date.now() < tvdbTokenExpiry) return tvdbToken;

  const res = await fetch('https://api4.thetvdb.com/v4/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: TVDB_API_KEY }),
  });

  if (!res.ok) throw new Error(`TVDB login failed: ${res.status}`);

  const { data } = await res.json();
  tvdbToken       = data.token;
  tvdbTokenExpiry = Date.now() + 23 * 60 * 60 * 1000;

  console.log('TVDB token refreshed');
  return tvdbToken;
}

// ---------------------------------------------------------------------------
// TMDB — résolution tvdbId → tmdbId (avec cache)
// ---------------------------------------------------------------------------

const tmdbIdCache = new Map();

async function resolveTmdbId(tvdbId) {
  if (tmdbIdCache.has(tvdbId)) return tmdbIdCache.get(tvdbId);

  const res = await fetch(
    `https://api.themoviedb.org/3/find/${tvdbId}?external_source=tvdb_id`,
    { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
  );

  const tmdbId = res.ok ? ((await res.json()).tv_results?.[0]?.id ?? null) : null;
  tmdbIdCache.set(tvdbId, tmdbId);
  return tmdbId;
}

// ---------------------------------------------------------------------------
// TMDB — détail série avec cache (évite les appels dupliqués)
// ---------------------------------------------------------------------------

const tmdbDetailCache = new Map();

async function fetchTmdbShowDetail(tmdbId) {
  if (tmdbDetailCache.has(tmdbId)) return tmdbDetailCache.get(tmdbId);

  const res = await fetch(
    `https://api.themoviedb.org/3/tv/${tmdbId}`,
    { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
  );

  const data = res.ok ? await res.json() : null;
  tmdbDetailCache.set(tmdbId, data);
  return data;
}

// ---------------------------------------------------------------------------
// TVDB — traduction série
// Retourne { name, overview, originalLanguage (ISO 639-2), source: 'tvdb' } ou null
// ---------------------------------------------------------------------------

async function getTvdbTranslation(tvdbId) {
  try {
    const token = await getTvdbToken();
    const needsOrigLang = SHOW_TITLE_MODE === 'native' || SHOW_OVERVIEW_MODE === 'native';

    const [transRes, seriesRes] = await Promise.all([
      fetch(`https://api4.thetvdb.com/v4/series/${tvdbId}/translations/${LANGUAGE}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      needsOrigLang
        ? fetch(`https://api4.thetvdb.com/v4/series/${tvdbId}`, {
            headers: { Authorization: `Bearer ${token}` },
          })
        : Promise.resolve(null),
    ]);

    if (transRes.status === 401 || seriesRes?.status === 401) {
      tvdbToken = null;
      return getTvdbTranslation(tvdbId);
    }

    if (transRes.status === 404) return null;
    if (!transRes.ok) return null;

    const { data: transData } = await transRes.json();

    let originalLanguage = null;
    if (seriesRes?.ok) {
      const { data: seriesData } = await seriesRes.json();
      originalLanguage = seriesData?.originalLanguage ?? null;
    }

    return {
      name:     transData?.name     || null,
      overview: transData?.overview || null,
      originalLanguage,
      source: 'tvdb',
    };
  } catch (err) {
    console.warn(`TVDB translation fetch failed for ${tvdbId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TVDB — IDs des saisons d'une série (map seasonNumber → tvdbSeasonId)
// ---------------------------------------------------------------------------

async function getTvdbSeasonIds(tvdbId) {
  try {
    const token = await getTvdbToken();
    const res = await fetch(`https://api4.thetvdb.com/v4/series/${tvdbId}/seasons`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.status === 401) { tvdbToken = null; return getTvdbSeasonIds(tvdbId); }
    if (!res.ok) return {};

    const { data } = await res.json();
    // Filtre sur le type "official" pour correspondre au numérotage Skyhook
    const official = (data ?? []).filter(s => !s.type?.type || s.type.type === 'official');
    return Object.fromEntries(official.map(s => [s.number, s.id]));
  } catch (err) {
    console.warn(`TVDB season IDs fetch failed for ${tvdbId}:`, err.message);
    return {};
  }
}

// ---------------------------------------------------------------------------
// TVDB — traduction saison
// ---------------------------------------------------------------------------

async function getTvdbSeasonTranslation(seasonId) {
  try {
    const token = await getTvdbToken();
    const res = await fetch(
      `https://api4.thetvdb.com/v4/seasons/${seasonId}/translations/${LANGUAGE}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (res.status === 401) { tvdbToken = null; return getTvdbSeasonTranslation(seasonId); }
    if (!res.ok) return null;

    const { data } = await res.json();
    return { name: data?.name || null, overview: data?.overview || null };
  } catch (err) {
    console.warn(`TVDB season translation fetch failed for season ${seasonId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TVDB — traduction épisode
// ---------------------------------------------------------------------------

async function getTvdbEpisodeTranslation(episodeId) {
  try {
    const token = await getTvdbToken();
    const res = await fetch(
      `https://api4.thetvdb.com/v4/episodes/${episodeId}/translations/${LANGUAGE}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (res.status === 404) return null;
    if (res.status === 401) { tvdbToken = null; return getTvdbEpisodeTranslation(episodeId); }
    if (!res.ok) return null;

    const { data } = await res.json();
    return { name: data?.name || null, overview: data?.overview || null };
  } catch (err) {
    console.warn(`TVDB episode translation fetch failed for ${episodeId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TMDB — traduction série
// Retourne { name, overview, originalLanguage (ISO 639-1), source: 'tmdb' } ou null
// ---------------------------------------------------------------------------

async function getTmdbTranslation(tvdbId) {
  try {
    const tmdbId = await resolveTmdbId(tvdbId);
    if (!tmdbId) return null;

    const [transRes, detail] = await Promise.all([
      fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/translations`, {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      }),
      fetchTmdbShowDetail(tmdbId),
    ]);

    if (!transRes.ok) return null;

    const { translations } = await transRes.json();
    const langTrans = translations?.find(t => t.iso_639_1 === langIso1);

    return {
      name:             langTrans?.data?.name     || null,
      overview:         langTrans?.data?.overview || null,
      originalLanguage: detail?.original_language || null,
      source: 'tmdb',
    };
  } catch (err) {
    console.warn(`TMDB translation fetch failed for tvdbId ${tvdbId}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TMDB — traduction saison
// ---------------------------------------------------------------------------

async function getTmdbSeasonTranslation(tmdbId, seasonNumber) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}/translations`,
      { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
    );
    if (!res.ok) return null;

    const { translations } = await res.json();
    const langTrans = translations?.find(t => t.iso_639_1 === langIso1);
    return { name: langTrans?.data?.name || null, overview: langTrans?.data?.overview || null };
  } catch (err) {
    console.warn(`TMDB season translation fetch failed (tmdbId ${tmdbId}, season ${seasonNumber}):`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TMDB — traduction épisode
// ---------------------------------------------------------------------------

async function getTmdbEpisodeTranslation(tmdbId, seasonNumber, episodeNumber) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}/translations`,
      { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
    );
    if (!res.ok) return null;

    const { translations } = await res.json();
    const langTrans = translations?.find(t => t.iso_639_1 === langIso1);
    return { name: langTrans?.data?.name || null, overview: langTrans?.data?.overview || null };
  } catch (err) {
    console.warn(`TMDB episode translation fetch failed (tmdbId ${tmdbId}, S${seasonNumber}E${episodeNumber}):`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// TMDB — valeur par défaut (langue originale) pour série / saison / épisode
// Utilisée quand aucune traduction n'est disponible dans aucune source
// ---------------------------------------------------------------------------

async function getTmdbShowDefault(tmdbId) {
  try {
    const detail = await fetchTmdbShowDetail(tmdbId); // utilise le cache
    return detail ? { name: detail.name || null, overview: detail.overview || null } : null;
  } catch (err) {
    console.warn(`TMDB show default fetch failed (tmdbId ${tmdbId}):`, err.message);
    return null;
  }
}

async function getTmdbSeasonDefault(tmdbId, seasonNumber) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}`,
      { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { name: data.name || null, overview: data.overview || null };
  } catch (err) {
    console.warn(`TMDB season default fetch failed (tmdbId ${tmdbId}, season ${seasonNumber}):`, err.message);
    return null;
  }
}

async function getTmdbEpisodeDefault(tmdbId, seasonNumber, episodeNumber) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/season/${seasonNumber}/episode/${episodeNumber}`,
      { headers: { Authorization: `Bearer ${TMDB_API_KEY}` } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return { name: data.name || null, overview: data.overview || null };
  } catch (err) {
    console.warn(`TMDB episode default fetch failed (tmdbId ${tmdbId}, S${seasonNumber}E${episodeNumber}):`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Résolution de la source de traduction série avec fallback + default
// Chaîne : primary (fr) → secondary (fr) → primary (défaut) → secondary (défaut)
// ---------------------------------------------------------------------------

async function getTranslationData(tvdbId) {
  const primaryFn   = PRIMARY_SOURCE   === 'tvdb' ? getTvdbTranslation : getTmdbTranslation;
  const secondaryFn = SECONDARY_SOURCE === 'tvdb' ? getTvdbTranslation :
                      SECONDARY_SOURCE === 'tmdb' ? getTmdbTranslation : null;

  const [primary, secondary] = await Promise.all([
    primaryFn(tvdbId),
    secondaryFn ? secondaryFn(tvdbId) : Promise.resolve(null),
  ]);

  // Pas de résultat du tout → essayer le default TMDB si disponible
  if (!primary && !secondary) {
    if (needsTmdb) {
      const tmdbId = await resolveTmdbId(tvdbId);
      if (tmdbId) {
        const def = await getTmdbShowDefault(tmdbId);
        if (def) return { ...def, originalLanguage: null, source: 'tmdb' };
      }
    }
    return null;
  }

  const base = primary ?? secondary;
  if (!primary) console.log(`[translation] ${tvdbId} — primary not found, using secondary`);

  const merged = { ...base };

  // Fallback champ par champ entre translations
  if (primary && secondary) {
    if (merged.name     === null && secondary.name)     merged.name     = secondary.name;
    if (merged.overview === null && secondary.overview) merged.overview = secondary.overview;

    if (merged.name !== primary.name || merged.overview !== primary.overview) {
      const fields = [
        merged.name     !== primary.name     ? 'title'    : null,
        merged.overview !== primary.overview ? 'overview' : null,
      ].filter(Boolean).join(', ');
      console.log(`[translation] ${tvdbId} — field-level fallback from ${PRIMARY_SOURCE} to ${SECONDARY_SOURCE} (${fields})`);
    }
  }

  // Fallback vers valeur par défaut si des champs sont encore null
  if (merged.name === null || merged.overview === null) {
    const tmdbDefaultFn = needsTmdb ? async () => {
      const tmdbId = await resolveTmdbId(tvdbId);
      return tmdbId ? getTmdbShowDefault(tmdbId) : null;
    } : null;

    const primaryDefFn   = PRIMARY_SOURCE   === 'tmdb' ? tmdbDefaultFn : null;
    const secondaryDefFn = SECONDARY_SOURCE === 'tmdb' ? tmdbDefaultFn : null;

    if (primaryDefFn || secondaryDefFn) {
      const [primaryDef, secondaryDef] = await Promise.all([
        primaryDefFn?.()   ?? Promise.resolve(null),
        secondaryDefFn?.() ?? Promise.resolve(null),
      ]);
      if (merged.name     === null) merged.name     = primaryDef?.name     ?? secondaryDef?.name     ?? null;
      if (merged.overview === null) merged.overview = primaryDef?.overview ?? secondaryDef?.overview ?? null;
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Résolution avec fallback pour saisons et épisodes
// Chaîne : primary (fr) → secondary (fr) → primary (défaut) → secondary (défaut)
// TVDB default = valeur Skyhook (déjà présente) → pas d'appel supplémentaire
// ---------------------------------------------------------------------------

async function mergeSubTranslations(primaryTransFn, secondaryTransFn, primaryDefaultFn, secondaryDefaultFn) {
  const [primary, secondary] = await Promise.all([
    primaryTransFn?.()   ?? Promise.resolve(null),
    secondaryTransFn?.() ?? Promise.resolve(null),
  ]);

  const merged = {
    name:     primary?.name     ?? secondary?.name     ?? null,
    overview: primary?.overview ?? secondary?.overview ?? null,
  };

  // Si des champs sont encore null, on tente les valeurs par défaut
  if ((merged.name === null || merged.overview === null) && (primaryDefaultFn || secondaryDefaultFn)) {
    const [primaryDef, secondaryDef] = await Promise.all([
      primaryDefaultFn?.()   ?? Promise.resolve(null),
      secondaryDefaultFn?.() ?? Promise.resolve(null),
    ]);
    if (merged.name     === null) merged.name     = primaryDef?.name     ?? secondaryDef?.name     ?? null;
    if (merged.overview === null) merged.overview = primaryDef?.overview ?? secondaryDef?.overview ?? null;
  }

  return merged;
}

async function getSeasonTranslation(seasonNumber, tvdbSeasonIds, tmdbId) {
  const tvdbSeasonId = tvdbSeasonIds?.[seasonNumber] ?? null;

  const tvdbTransFn   = tvdbSeasonId ? () => getTvdbSeasonTranslation(tvdbSeasonId)          : null;
  const tmdbTransFn   = tmdbId       ? () => getTmdbSeasonTranslation(tmdbId, seasonNumber)   : null;
  const tmdbDefaultFn = tmdbId       ? () => getTmdbSeasonDefault(tmdbId, seasonNumber)        : null;
  // TVDB default = Skyhook, pas d'appel supplémentaire

  const primaryTransFn     = PRIMARY_SOURCE   === 'tvdb' ? tvdbTransFn   : tmdbTransFn;
  const secondaryTransFn   = SECONDARY_SOURCE === 'tvdb' ? tvdbTransFn   :
                             SECONDARY_SOURCE === 'tmdb' ? tmdbTransFn   : null;
  const primaryDefaultFn   = PRIMARY_SOURCE   === 'tmdb' ? tmdbDefaultFn : null;
  const secondaryDefaultFn = SECONDARY_SOURCE === 'tmdb' ? tmdbDefaultFn : null;

  if (!primaryTransFn && !primaryDefaultFn) return null;
  return mergeSubTranslations(primaryTransFn, secondaryTransFn, primaryDefaultFn, secondaryDefaultFn);
}

async function getEpisodeTranslation(episode, tmdbId) {
  const tvdbTransFn   = episode.tvdbId ? () => getTvdbEpisodeTranslation(episode.tvdbId)                                                           : null;
  const tmdbTransFn   = tmdbId         ? () => getTmdbEpisodeTranslation(tmdbId, episode.seasonNumber, episode.episodeNumber)                       : null;
  const tmdbDefaultFn = tmdbId         ? () => getTmdbEpisodeDefault(tmdbId, episode.seasonNumber, episode.episodeNumber)                           : null;
  // TVDB default = Skyhook, pas d'appel supplémentaire

  const primaryTransFn     = PRIMARY_SOURCE   === 'tvdb' ? tvdbTransFn   : tmdbTransFn;
  const secondaryTransFn   = SECONDARY_SOURCE === 'tvdb' ? tvdbTransFn   :
                             SECONDARY_SOURCE === 'tmdb' ? tmdbTransFn   : null;
  const primaryDefaultFn   = PRIMARY_SOURCE   === 'tmdb' ? tmdbDefaultFn : null;
  const secondaryDefaultFn = SECONDARY_SOURCE === 'tmdb' ? tmdbDefaultFn : null;

  if (!primaryTransFn && !primaryDefaultFn) return null;
  return mergeSubTranslations(primaryTransFn, secondaryTransFn, primaryDefaultFn, secondaryDefaultFn);
}

// ---------------------------------------------------------------------------
// Application des traductions selon SHOW_TITLE_MODE / SHOW_OVERVIEW_MODE
// ---------------------------------------------------------------------------

function isNativeLanguage(translationData) {
  if (!translationData?.originalLanguage) return false;
  // TVDB retourne ISO 639-2 (ex: 'fra'), TMDB retourne ISO 639-1 (ex: 'fr')
  if (translationData.source === 'tvdb') return translationData.originalLanguage === LANGUAGE;
  return translationData.originalLanguage === langIso1;
}

function applyTranslations(show, translationData, context = '') {
  if (!translationData) return;

  const native     = isNativeLanguage(translationData);
  const doTitle    = SHOW_TITLE_MODE    === 'always' || (SHOW_TITLE_MODE    === 'native' && native);
  const doOverview = SHOW_OVERVIEW_MODE === 'always' || (SHOW_OVERVIEW_MODE === 'native' && native);

  if (doTitle && translationData.name) {
    console.log(`[${context}] title "${show.title}" → "${translationData.name}" (${translationData.source})`);
    show.title = translationData.name;
  }
  if (doOverview && translationData.overview) {
    show.overview = translationData.overview;
  }
}

// ---------------------------------------------------------------------------
// Skyhook — forward vers le vrai skyhook.sonarr.tv
// ---------------------------------------------------------------------------

async function fetchSkyhook(urlPath) {
  const res = await fetch(`https://skyhook.sonarr.tv${urlPath}`);
  if (!res.ok) throw new Error(`Skyhook returned ${res.status} for ${urlPath}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Gestionnaire de requêtes
// ---------------------------------------------------------------------------

async function handleRequest(req, res) {
  const url = new URL(req.url, 'http://localhost');

  try {
    // GET /v1/tvdb/shows/en/:tvdbId — fiche détaillée d'une série
    const showMatch = url.pathname.match(/^\/v1\/tvdb\/shows\/en\/(\d+)$/);
    if (req.method === 'GET' && showMatch) {
      const tvdbId = showMatch[1];

      const [show, translationData] = await Promise.all([
        fetchSkyhook(url.pathname + url.search),
        getTranslationData(tvdbId),
      ]);

      applyTranslations(show, translationData, `shows/${tvdbId}`);

      const native            = isNativeLanguage(translationData);
      const doSeasonTitle     = SEASON_TITLE_MODE     === 'always' || (SEASON_TITLE_MODE     === 'native' && native);
      const doSeasonOverview  = SEASON_OVERVIEW_MODE  === 'always' || (SEASON_OVERVIEW_MODE  === 'native' && native);
      const doEpisodeTitle    = EPISODE_TITLE_MODE    === 'always' || (EPISODE_TITLE_MODE    === 'native' && native);
      const doEpisodeOverview = EPISODE_OVERVIEW_MODE === 'always' || (EPISODE_OVERVIEW_MODE === 'native' && native);

      const needsSeasons  = (doSeasonTitle  || doSeasonOverview)  && Array.isArray(show.seasons)  && show.seasons.length  > 0;
      const needsEpisodes = (doEpisodeTitle || doEpisodeOverview) && Array.isArray(show.episodes) && show.episodes.length > 0;

      if (needsSeasons || needsEpisodes) {
        const [tmdbId, tvdbSeasonIds] = await Promise.all([
          needsTmdb ? resolveTmdbId(tvdbId) : Promise.resolve(null),
          needsTvdb && needsSeasons ? getTvdbSeasonIds(tvdbId) : Promise.resolve({}),
        ]);

        if (needsSeasons) {
          show.seasons = await Promise.all(
            show.seasons.map(async (season) => {
              const t = await getSeasonTranslation(season.seasonNumber, tvdbSeasonIds, tmdbId);
              if (doSeasonTitle    && t?.name)     season.name     = t.name;
              if (doSeasonOverview && t?.overview) season.overview = t.overview;
              return season;
            }),
          );
          console.log(`[shows/${tvdbId}] ${show.seasons.length} seasons translated`);
        }

        if (needsEpisodes) {
          show.episodes = await Promise.all(
            show.episodes.map(async (episode) => {
              const t = await getEpisodeTranslation(episode, tmdbId);
              if (doEpisodeTitle    && t?.name)     episode.title    = t.name;
              if (doEpisodeOverview && t?.overview) episode.overview = t.overview;
              return episode;
            }),
          );
          console.log(`[shows/${tvdbId}] ${show.episodes.length} episodes translated`);
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(show));
    }

    // GET /v1/tvdb/search/en/ — recherche par nom (plusieurs résultats)
    if (req.method === 'GET' && url.pathname.startsWith('/v1/tvdb/search/en/')) {
      const shows      = await fetchSkyhook(url.pathname + url.search);
      const translated = await Promise.all(
        shows.map(async (show) => {
          const translationData = await getTranslationData(show.tvdbId);
          applyTranslations(show, translationData, `search/${show.tvdbId}`);
          return show;
        }),
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(translated));
    }

    // GET /health — healthcheck Docker
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ status: 'ok', language: LANGUAGE, primary: PRIMARY_SOURCE, secondary: SECONDARY_SOURCE }));
    }

    // Catch-all — passthrough transparent vers Skyhook
    const upstream = await fetch(`https://skyhook.sonarr.tv${url.pathname}${url.search}`);
    const body     = await upstream.text();
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json',
    });
    res.end(body);

  } catch (err) {
    console.error(`Error handling ${req.method} ${req.url}:`, err.message);
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad gateway', detail: err.message }));
  }
}

// ---------------------------------------------------------------------------
// Génération automatique des certificats TLS si absents
// ---------------------------------------------------------------------------

if (CERT_DIR) {
  const caKey  = path.join(CERT_DIR, 'ca.key');
  const caCrt  = path.join(CERT_DIR, 'ca.crt');
  const srvKey = path.join(CERT_DIR, 'server.key');
  const srvCrt = path.join(CERT_DIR, 'server.crt');
  const csrTmp = path.join(CERT_DIR, 'server.csr');
  const sanTmp = path.join(CERT_DIR, 'san.cnf');

  if (!fs.existsSync(srvCrt) || !fs.existsSync(srvKey)) {
    console.log('TLS certificates not found — generating...');
    fs.mkdirSync(CERT_DIR, { recursive: true });
    fs.writeFileSync(sanTmp, 'subjectAltName=DNS:skyhook.sonarr.tv');
    try {
      execSync(`openssl genrsa -out "${caKey}" 4096 2>/dev/null`);
      execSync(`openssl req -new -x509 -days 3650 -key "${caKey}" -out "${caCrt}" -subj "/CN=Glossarr CA"`);
      execSync(`openssl genrsa -out "${srvKey}" 2048 2>/dev/null`);
      execSync(`openssl req -new -key "${srvKey}" -out "${csrTmp}" -subj "/CN=skyhook.sonarr.tv"`);
      execSync(`openssl x509 -req -days 3650 -in "${csrTmp}" -CA "${caCrt}" -CAkey "${caKey}" -CAcreateserial -out "${srvCrt}" -extfile "${sanTmp}"`);
      console.log(`TLS certificates generated in ${CERT_DIR}`);
      console.log(`  → ca.crt: mount this into Sonarr to trust Glossarr`);
    } finally {
      for (const f of [csrTmp, sanTmp, path.join(CERT_DIR, 'ca.srl')]) {
        fs.rmSync(f, { force: true });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Démarrage des serveurs
// ---------------------------------------------------------------------------

// HTTP — toujours actif (healthcheck + mode dev)
http.createServer(handleRequest).listen(PORT_HTTP, () => {
  console.log(`HTTP  listening on :${PORT_HTTP}  (language: ${LANGUAGE}, primary: ${PRIMARY_SOURCE}, secondary: ${SECONDARY_SOURCE ?? 'none'}, show: ${SHOW_TITLE_MODE}/${SHOW_OVERVIEW_MODE}, season: ${SEASON_TITLE_MODE}/${SEASON_OVERVIEW_MODE}, episode: ${EPISODE_TITLE_MODE}/${EPISODE_OVERVIEW_MODE})`);
});

// HTTPS — uniquement en prod quand CERT_DIR est défini
if (CERT_DIR) {
  const key  = fs.readFileSync(path.join(CERT_DIR, 'server.key'));
  const cert = fs.readFileSync(path.join(CERT_DIR, 'server.crt'));
  https.createServer({ key, cert }, handleRequest).listen(PORT_HTTPS, () => {
    console.log(`HTTPS listening on :${PORT_HTTPS} (language: ${LANGUAGE}, primary: ${PRIMARY_SOURCE}, secondary: ${SECONDARY_SOURCE ?? 'none'}, show: ${SHOW_TITLE_MODE}/${SHOW_OVERVIEW_MODE}, season: ${SEASON_TITLE_MODE}/${SEASON_OVERVIEW_MODE}, episode: ${EPISODE_TITLE_MODE}/${EPISODE_OVERVIEW_MODE})`);
  });
}
