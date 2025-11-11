import express from 'express';
import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Global Variables ---
const app = express();
const port = 3000;

// Environment variables
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

// In-memory cache for Spotify token
let spotifyToken = {
  value: null,
  expiresAt: 0,
};

// CACHE SYSTEM - Stores recommendations and explanations
const recommendationsCache = new Map(); // key: "trackname|artistname"
const explanationsCache = new Map(); // key: "seedSong|recommendationSong"
const CACHE_DURATION = 1000 * 60 * 60; // 1 hour

// Cache helper functions
function getCacheKey(songName, artistName) {
  return `${songName.toLowerCase().trim()}|${artistName.toLowerCase().trim()}`;
}

function getCachedRecommendations(songName, artistName) {
  const key = getCacheKey(songName, artistName);
  const cached = recommendationsCache.get(key);
  
  if (cached && Date.now() < cached.expiresAt) {
    console.log(`✅ Cache HIT for "${songName}" by ${artistName}`);
    return cached.data;
  }
  
  console.log(`❌ Cache MISS for "${songName}" by ${artistName}`);
  return null;
}

function setCachedRecommendations(songName, artistName, data) {
  const key = getCacheKey(songName, artistName);
  recommendationsCache.set(key, {
    data: data,
    expiresAt: Date.now() + CACHE_DURATION
  });
  console.log(`💾 Cached recommendations for "${songName}" by ${artistName}`);
}

function getCachedExplanation(seedSong, recommendation) {
  const key = `${seedSong.name}|${seedSong.artist}|${recommendation.title}|${recommendation.artist}`;
  const cached = explanationsCache.get(key.toLowerCase());
  
  if (cached && Date.now() < cached.expiresAt) {
    return cached.data;
  }
  
  return null;
}

function setCachedExplanation(seedSong, recommendation, explanation) {
  const key = `${seedSong.name}|${seedSong.artist}|${recommendation.title}|${recommendation.artist}`;
  explanationsCache.set(key.toLowerCase(), {
    data: explanation,
    expiresAt: Date.now() + CACHE_DURATION
  });
}

// --- Spotify API Helper Functions ---

async function getSpotifyToken() {
  if (spotifyToken.value && spotifyToken.expiresAt > Date.now()) {
    return spotifyToken.value;
  }

  console.log('Refreshing Spotify token...');
  const authBuffer = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`,
  ).toString('base64');

  try {
    const bodyParams = new URLSearchParams();
    bodyParams.append('grant_type', 'client_credentials');

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authBuffer}`,
      },
      body: bodyParams,
    });

    if (!response.ok) {
      throw new Error(`Spotify token failed: ${response.status}`);
    }

    const data = await response.json();
    spotifyToken.value = data.access_token;
    spotifyToken.expiresAt = Date.now() + 3300 * 1000;

    console.log('Spotify token refreshed.');
    return spotifyToken.value;
  } catch (error) {
    console.error('Error refreshing Spotify token:', error);
    throw error;
  }
}

async function searchSpotifyTrack(songName, artistName) {
  const token = await getSpotifyToken();

  // Try 1: Strict search (exact match)
  let searchQuery = encodeURIComponent(`track:${songName} artist:${artistName}`);
  let url = `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=1&market=US`;

  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify search failed: ${response.status}`);
  }

  let data = await response.json();

  // If strict search found nothing, try fuzzy search (handles typos, apostrophes, etc.)
  if (!data.tracks?.items?.[0]) {
    console.log(`Strict search failed for "${songName}" by "${artistName}", trying fuzzy search...`);
    searchQuery = encodeURIComponent(`${songName} ${artistName}`); // No strict filters
    url = `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=5&market=US`; // Get top 5 to pick most popular

    response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    data = await response.json();

    if (data.tracks?.items?.length > 0) {
      // Sort by popularity and pick the most popular track
      const sortedByPopularity = data.tracks.items.sort((a, b) => b.popularity - a.popularity);
      const topResult = sortedByPopularity[0];

      console.log(`✅ Fuzzy search found: "${topResult.name}" by ${topResult.artists[0].name} (popularity: ${topResult.popularity})`);

      // Return the most popular result in the same format
      data.tracks.items = [topResult];
    }
  }

  return data.tracks?.items?.[0] || null;
}

async function getSpotifyTrack(trackId) {
  const token = await getSpotifyToken();
  const url = `https://api.spotify.com/v1/tracks/${trackId}?market=US`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify track fetch failed: ${response.status}`);
  }

  return await response.json();
}

// --- Last.fm API Helper Functions ---

async function getLastfmSimilarTracks(trackName, artistName) {
  const url = `http://ws.audioscrobbler.com/2.0/?method=track.getsimilar&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=${LASTFM_API_KEY}&format=json&limit=50`;

  const response = await fetch(url);
  
  if (!response.ok) {
    throw new Error(`Last.fm API failed: ${response.status}`);
  }

  const data = await response.json();
  
  if (data.error) {
    throw new Error(`Last.fm error: ${data.message}`);
  }

  return data.similartracks?.track || [];
}

async function enrichWithSpotify(lastfmTracks, seedArtist) {
  console.log(`Enriching ${lastfmTracks.length} Last.fm tracks with Spotify data...`);
  console.log(`Goal: At least 4 tracks from different artists (40% diversity minimum)`);
  
  // VARIATION: Shuffle the Last.fm results for different recommendations each time
  const shuffled = lastfmTracks.sort(() => Math.random() - 0.5);
  
  // Process tracks in parallel for maximum speed
  const tracksToProcess = shuffled.slice(0, 20);
  
  console.log(`Processing ${tracksToProcess.length} tracks in parallel (shuffled for variation)...`);
  
  const enrichmentPromises = tracksToProcess.map(async (track) => {
    try {
      const spotifyTrack = await searchSpotifyTrack(track.name, track.artist.name);
      
      if (spotifyTrack) {
        const hasPreview = !!spotifyTrack.preview_url;
        if (!hasPreview) {
          console.log(`⚠️ No preview URL for: "${spotifyTrack.name}" by ${spotifyTrack.artists[0].name}`);
        }

        return {
          name: spotifyTrack.name,
          artist: spotifyTrack.artists[0].name,
          url: spotifyTrack.external_urls.spotify,
          uri: spotifyTrack.uri,
          albumCover: spotifyTrack.album?.images?.[1]?.url || spotifyTrack.album?.images?.[0]?.url || null,
          albumName: spotifyTrack.album?.name || 'Unknown Album',
          popularity: spotifyTrack.popularity,
          matchScore: parseFloat(track.match || 0),
          isSameArtist: track.artist.name.toLowerCase() === seedArtist.toLowerCase(),
          previewUrl: spotifyTrack.preview_url || null
        };
      }
      return null;
    } catch (error) {
      return null;
    }
  });
  
  // Wait for all to complete
  const allResults = await Promise.all(enrichmentPromises);
  const allEnriched = allResults.filter(Boolean);
  
  console.log(`  ✓ Successfully enriched ${allEnriched.length} tracks`);
  
  // Separate by artist
  const sameArtist = allEnriched.filter(t => t.isSameArtist);
  const differentArtist = allEnriched.filter(t => !t.isSameArtist);
  
  console.log(`  ✓ ${sameArtist.length} same-artist, ${differentArtist.length} different-artist tracks`);
  
  // Build final list: prioritize different artists, ensure at least 4
  let combined = [];
  
  // Add all different artists first (up to 10)
  combined.push(...differentArtist.slice(0, 10));
  
  // Fill remaining slots with same artist
  const remaining = 10 - combined.length;
  if (remaining > 0) {
    combined.push(...sameArtist.slice(0, remaining));
  }
  
  // Ensure minimum 40% diversity
  const differentCount = combined.filter(t => !t.isSameArtist).length;
  if (differentCount < 4 && sameArtist.length > 0) {
    const maxSameArtist = Math.min(6, 10 - differentArtist.length);
    combined = [
      ...differentArtist,
      ...sameArtist.slice(0, maxSameArtist)
    ].slice(0, 10);
  }
  
  const finalDifferentCount = combined.filter(t => !t.isSameArtist).length;
  const finalSameCount = combined.length - finalDifferentCount;
  
  console.log(`\n📊 Results: ${finalSameCount} same-artist, ${finalDifferentCount} different-artist tracks`);
  console.log(`📦 Returning ${combined.length} total tracks (${Math.round(finalDifferentCount/combined.length*100)}% diversity)\n`);
  
  return combined;
}

// --- Main Workflow ---

async function getRecommendations(seedSong) {
  console.log(`--- Getting recommendations for: "${seedSong.name}" by ${seedSong.artist} ---`);
  console.log('Seed song data:', seedSong); // Debug log
  console.time('Total recommendation time');

  // Get similar tracks from Last.fm
  console.time('Last.fm API call');
  const lastfmSimilar = await getLastfmSimilarTracks(seedSong.name, seedSong.artist);
  console.timeEnd('Last.fm API call');
  
  if (!lastfmSimilar || lastfmSimilar.length === 0) {
    throw new Error('No similar tracks found on Last.fm.');
  }

  console.log(`Last.fm returned ${lastfmSimilar.length} similar tracks`);

  // Enrich with Spotify data
  console.time('Spotify enrichment');
  const recommendations = await enrichWithSpotify(lastfmSimilar, seedSong.artist);
  console.timeEnd('Spotify enrichment');

  if (recommendations.length === 0) {
    throw new Error('Could not find Spotify links for similar tracks.');
  }

  console.log(`Successfully enriched ${recommendations.length} recommendations (${recommendations.filter(r => r.artist.toLowerCase() === seedSong.artist.toLowerCase()).length} same artist, ${recommendations.filter(r => r.artist.toLowerCase() !== seedSong.artist.toLowerCase()).length} different artists)`);

  console.timeEnd('Total recommendation time');

  return {
    seedQuery: {
      type: 'song',
      name: seedSong.name,
      artist: seedSong.artist,
      url: seedSong.url,
      albumCover: seedSong.albumCover,
      albumName: seedSong.albumName,
      popularity: seedSong.popularity,
    },
    recommendations: recommendations,
  };
}

// --- Server Setup ---
app.use(express.json());

// Enable CORS for web interface
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Serve static files
app.use(express.static(__dirname));

// NEW: Endpoint to get AI explanation for a specific track
app.post('/api/explain', async (req, res) => {
  const { seedSong, recommendation } = req.body;

  if (!seedSong || !recommendation) {
    return res.status(400).json({ error: 'Missing required data' });
  }

  try {
    // CHECK CACHE FIRST
    const cachedExplanation = getCachedExplanation(seedSong, recommendation);
    if (cachedExplanation) {
      console.log(`✅ Explanation cache HIT`);
      return res.json({ explanation: cachedExplanation });
    }

    console.log(`❌ Explanation cache MISS - calling Gemini API`);

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      return res.json({ explanation: 'Similar musical style and energy' });
    }

    const model = 'gemini-2.5-flash-preview-09-2025';
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;

    const prompt = `Based on "${seedSong.name}" by ${seedSong.artist}, explain in ONE SHORT sentence (max 15 words) why "${recommendation.title}" by ${recommendation.artist} is musically similar. Be concise and focus on ONE key similarity.`;

    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
    };

    // Retry logic with timeout
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000); // 5 second timeout

        const response = await fetch(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });

        clearTimeout(timeout);

        if (!response.ok) {
          const errorText = await response.text();
          console.error(`Gemini API error (attempt ${attempt + 1}):`, response.status, errorText);
          lastError = new Error(`Gemini API returned ${response.status}`);

          // Don't retry on 4xx errors (bad request, auth issues)
          if (response.status >= 400 && response.status < 500) {
            break;
          }

          // Wait before retry on 5xx errors
          if (attempt < 1) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
        } else {
          const result = await response.json();
          const explanation = result.candidates?.[0]?.content?.parts?.[0]?.text || 'Similar musical style';

          // Only cache successful explanations
          setCachedExplanation(seedSong, recommendation, explanation);
          return res.json({ explanation });
        }
      } catch (fetchError) {
        console.error(`Gemini fetch error (attempt ${attempt + 1}):`, fetchError.message);
        lastError = fetchError;

        if (attempt < 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    // If all retries failed, return a music-based fallback
    const isSameArtist = recommendation.artist.toLowerCase() === seedSong.artist.toLowerCase();

    // Build smarter fallback using metadata
    let fallback;
    if (isSameArtist) {
      fallback = `More great music from ${recommendation.artist}`;
    } else if (recommendation.albumName && recommendation.albumName !== 'Unknown Album') {
      fallback = `From "${recommendation.albumName}"`;
    } else {
      fallback = 'Similar musical style and vibe';
    }

    console.error('All Gemini attempts failed, using fallback');
    res.json({ explanation: fallback });

  } catch (error) {
    console.error('Explanation error:', error);
    res.json({ explanation: 'Similar musical style' });
  }
});

app.post('/api/recommend', async (req, res) => {
  const { query } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Query is required.' });
  }

  try {
    let seedSong;

    // Check for Spotify link
    const spotifyTrackId = query.match(
      /open\.spotify\.com\/track\/([a-zA-Z0-9]+)/,
    )?.[1];

    if (spotifyTrackId) {
      console.log('--- Spotify Link Detected ---');
      const track = await getSpotifyTrack(spotifyTrackId);
      seedSong = {
        name: track.name,
        artist: track.artists[0].name,
        url: track.external_urls.spotify,
        albumCover: track.album?.images?.[1]?.url || track.album?.images?.[0]?.url || null,
        albumName: track.album?.name || 'Unknown Album',
        popularity: track.popularity,
      };
    } else {
      // Plain text song search
      console.log('--- Plain Text Song Search ---');
      
      // Simple parse - expect "Song by Artist" format
      const parts = query.split(/\s+by\s+/i);
      if (parts.length < 2) {
        throw new Error('Please use format: "Song Name by Artist Name"');
      }
      
      const songName = parts[0].trim();
      const artistName = parts.slice(1).join(' by ').trim();
      
      console.log(`Searching for: "${songName}" by "${artistName}"`);
      
      const spotifyTrack = await searchSpotifyTrack(songName, artistName);
      
      if (!spotifyTrack) {
        throw new Error(`Couldn't find "${songName}" by "${artistName}" on Spotify`);
      }
      
      seedSong = {
        name: spotifyTrack.name,
        artist: spotifyTrack.artists[0].name,
        url: spotifyTrack.external_urls.spotify,
        albumCover: spotifyTrack.album?.images?.[1]?.url || spotifyTrack.album?.images?.[0]?.url || null,
        albumName: spotifyTrack.album?.name || 'Unknown Album',
        popularity: spotifyTrack.popularity,
      };
    }

    // Get recommendations
    const finalContext = await getRecommendations(seedSong);

    console.log('Final context seedQuery:', finalContext.seedQuery); // Debug log

    // Return results immediately (NO GEMINI)
    const quickResponse = `Based on "${finalContext.seedQuery.name}" by ${finalContext.seedQuery.artist}, here are ${finalContext.recommendations.length} similar tracks:

${finalContext.recommendations.map((r, i) => 
  `${i + 1}. ${r.name} by ${r.artist}`
).join('\n')}`;

    res.json({ 
      response: quickResponse,
      seedSong: {
        name: finalContext.seedQuery.name,
        artist: finalContext.seedQuery.artist,
        albumCover: finalContext.seedQuery.albumCover,
        albumName: finalContext.seedQuery.albumName,
        url: finalContext.seedQuery.url
      },
      recommendations: finalContext.recommendations.map(r => ({
        title: r.name,
        artist: r.artist,
        url: r.url,
        uri: r.uri,
        albumCover: r.albumCover,
        albumName: r.albumName,
        spotifyLink: r.uri,
        previewUrl: r.previewUrl
      }))
    });

  } catch (error) {
    console.error(`Error: ${error.message}`);
    res.status(500).json({ 
      error: error.message || 'An error occurred.' 
    });
  }
});

// BONUS: Cache statistics endpoint for demo
app.get('/api/cache-stats', (req, res) => {
  res.json({
    recommendations: {
      size: recommendationsCache.size,
      entries: Array.from(recommendationsCache.keys())
    },
    explanations: {
      size: explanationsCache.size
    },
    message: 'Cache helps reduce API calls during demos!'
  });
});

// Serve index.html at root
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

// Start server
const PORT = process.env.PORT || port;
app.listen(PORT, async () => {
  try {
    await getSpotifyToken();
    console.log('✅ Spotify token ready');
  } catch (error) {
    console.error('⚠️  Spotify token failed:', error.message);
  }

  if (!LASTFM_API_KEY) {
    console.error('⚠️  LASTFM_API_KEY not found in .env');
  } else {
    console.log('✅ Last.fm API key loaded');
  }

  console.log(`\n🎵 Music Recommender listening at http://localhost:${PORT}`);
  console.log('📮 Ready at POST /api/recommend');
  console.log('💾 Cache system enabled (1 hour TTL)');
  console.log(`📊 Cache stats at GET /api/cache-stats\n`);
});