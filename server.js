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

// Session management for user authentication
const userSessions = new Map(); // key: sessionId, value: { accessToken, expiresAt, userId }
const REDIRECT_URI = process.env.REDIRECT_URI || 'http://localhost:3000/auth/callback';

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

  // Always get multiple results and pick the best one (handles typos, apostrophes, obscure versions)
  const searchQuery = encodeURIComponent(`${songName} ${artistName}`);
  const url = `https://api.spotify.com/v1/search?q=${searchQuery}&type=track&limit=10`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify search failed: ${response.status}`);
  }

  const data = await response.json();

  if (!data.tracks?.items?.length) {
    return null;
  }

  // Helper function to calculate artist name similarity
  function artistMatchScore(trackArtist, searchArtist) {
    const trackArtistLower = trackArtist.toLowerCase().trim();
    const searchArtistLower = searchArtist.toLowerCase().trim();

    // Exact match = 100 points
    if (trackArtistLower === searchArtistLower) {
      return 100;
    }

    // Contains the full artist name = 80 points
    if (trackArtistLower.includes(searchArtistLower) || searchArtistLower.includes(trackArtistLower)) {
      return 80;
    }

    // Starts with the artist name = 60 points
    if (trackArtistLower.startsWith(searchArtistLower) || searchArtistLower.startsWith(trackArtistLower)) {
      return 60;
    }

    // No match = 0 points
    return 0;
  }

  // Score each track: artist match (weighted 70%) + popularity (weighted 30%)
  const scoredTracks = data.tracks.items.map(track => {
    const artistScore = artistMatchScore(track.artists[0].name, artistName);
    const popularityScore = track.popularity;

    // Weighted score: artist match is more important than popularity
    const totalScore = (artistScore * 0.7) + (popularityScore * 0.3);

    return {
      track,
      artistScore,
      popularityScore,
      totalScore
    };
  });

  // Sort by total score (descending)
  scoredTracks.sort((a, b) => b.totalScore - a.totalScore);

  // Filter out tracks with very low popularity (< 20) unless they have perfect artist match
  const filtered = scoredTracks.filter(item =>
    item.popularityScore >= 20 || item.artistScore === 100
  );

  if (filtered.length === 0) {
    // If all tracks are filtered out, just use the best scoring one
    const topResult = scoredTracks[0].track;
    console.log(`⚠️ All results filtered, using best match: "${topResult.name}" by ${topResult.artists[0].name} (score: ${scoredTracks[0].totalScore.toFixed(1)})`);
    return topResult;
  }

  const topResult = filtered[0].track;
  console.log(`✅ Found: "${topResult.name}" by ${topResult.artists[0].name} (artist score: ${filtered[0].artistScore}, popularity: ${filtered[0].popularityScore}, total: ${filtered[0].totalScore.toFixed(1)})`);

  return topResult;
}

async function getSpotifyTrack(trackId) {
  const token = await getSpotifyToken();
  const url = `https://api.spotify.com/v1/tracks/${trackId}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Spotify track fetch failed: ${response.status}`);
  }

  return await response.json();
}

async function getAudioFeatures(trackId) {
  const token = await getSpotifyToken();
  const url = `https://api.spotify.com/v1/audio-features/${trackId}`;

  try {
    console.log(`🔍 Fetching audio features for track: ${trackId}`);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`⚠️ Audio features API error: ${response.status} - ${errorText}`);
      return null;
    }

    const features = await response.json();
    console.log(`📊 Raw Spotify audio features:`, JSON.stringify(features));

    // Check if we got valid data
    if (!features || typeof features !== 'object') {
      console.log(`⚠️ Invalid audio features response`);
      return null;
    }

    // Convert to 1-10 scale and return relevant features
    // Important: Use !== undefined check instead of truthiness to handle 0 values
    const result = {
      danceability: (features.energy !== undefined && features.energy !== null) ? Math.round(features.energy * 10) : null,
      mood: (features.valence !== undefined && features.valence !== null) ? Math.round(features.valence * 10) : null
    };

    console.log(`🎵 Converted audio features: Danceability=${result.danceability}/10 (from energy=${features.energy}), Mood=${result.mood}/10 (from valence=${features.valence})`);
    return result;
  } catch (error) {
    console.log(`⚠️ Audio features fetch error:`, error.message);
    return null;
  }
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

        // Fetch audio features for mood and danceability
        const trackId = spotifyTrack.id;
        const audioFeatures = await getAudioFeatures(trackId);

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
          previewUrl: spotifyTrack.preview_url || null,
          danceability: audioFeatures?.danceability ?? null,
          mood: audioFeatures?.mood ?? null
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

      // Append danceability and mood scores to cached explanation
      let explanation = cachedExplanation;
      const hasDanceability = recommendation.danceability !== null && recommendation.danceability !== undefined;
      const hasMood = recommendation.mood !== null && recommendation.mood !== undefined;

      // Only append if not already present (cached explanations from before this update)
      if (!explanation.includes('Danceability:') && !explanation.includes('Mood:')) {
        if (hasDanceability && hasMood) {
          explanation += ` (Danceability: ${recommendation.danceability}/10, Mood: ${recommendation.mood}/10)`;
        } else if (hasDanceability) {
          explanation += ` (Danceability: ${recommendation.danceability}/10)`;
        } else if (hasMood) {
          explanation += ` (Mood: ${recommendation.mood}/10)`;
        }
      }

      return res.json({ explanation });
    }

    console.log(`❌ Explanation cache MISS - calling Gemini API`);

    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    if (!GEMINI_API_KEY) {
      let explanation = 'Similar musical style and energy';
      const hasDanceability = recommendation.danceability !== null && recommendation.danceability !== undefined;
      const hasMood = recommendation.mood !== null && recommendation.mood !== undefined;

      if (hasDanceability && hasMood) {
        explanation += ` (Danceability: ${recommendation.danceability}/10, Mood: ${recommendation.mood}/10)`;
      } else if (hasDanceability) {
        explanation += ` (Danceability: ${recommendation.danceability}/10)`;
      } else if (hasMood) {
        explanation += ` (Mood: ${recommendation.mood}/10)`;
      }

      return res.json({ explanation });
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
          let explanation = result.candidates?.[0]?.content?.parts?.[0]?.text || 'Similar musical style';

          // Append danceability and mood scores if available
          const hasDanceability = recommendation.danceability !== null && recommendation.danceability !== undefined;
          const hasMood = recommendation.mood !== null && recommendation.mood !== undefined;

          if (hasDanceability && hasMood) {
            explanation += ` (Danceability: ${recommendation.danceability}/10, Mood: ${recommendation.mood}/10)`;
          } else if (hasDanceability) {
            explanation += ` (Danceability: ${recommendation.danceability}/10)`;
          } else if (hasMood) {
            explanation += ` (Mood: ${recommendation.mood}/10)`;
          }

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

    // If all retries failed, return a music-based fallback with variety
    const isSameArtist = recommendation.artist.toLowerCase() === seedSong.artist.toLowerCase();

    // Build smarter fallback using metadata + audio features
    let fallback;
    const hasDanceability = recommendation.danceability !== null && recommendation.danceability !== undefined;
    const hasMood = recommendation.mood !== null && recommendation.mood !== undefined;

    if (isSameArtist) {
      const sameArtistVariations = [
        `Another hit from ${recommendation.artist}`,
        `More great music from ${recommendation.artist}`,
        `${recommendation.artist}'s signature sound`,
        `Another track by ${recommendation.artist}`
      ];
      fallback = sameArtistVariations[Math.floor(Math.random() * sameArtistVariations.length)];

      // ALWAYS append danceability and mood scores
      if (hasDanceability && hasMood) {
        fallback += ` (Danceability: ${recommendation.danceability}/10, Mood: ${recommendation.mood}/10)`;
      } else if (hasDanceability) {
        fallback += ` (Danceability: ${recommendation.danceability}/10)`;
      } else if (hasMood) {
        fallback += ` (Mood: ${recommendation.mood}/10)`;
      }
    } else {
      // Use multiple data points for richer fallbacks
      const hasAlbum = recommendation.albumName && recommendation.albumName !== 'Unknown Album';

      const variations = [];

      if (hasAlbum) {
        variations.push(`From the album "${recommendation.albumName}"`);
        variations.push(`${recommendation.artist}'s comparable style`);
        variations.push(`Featured on "${recommendation.albumName}"`);
      } else {
        variations.push(`${recommendation.artist} brings similar energy`);
        variations.push(`Comparable style by ${recommendation.artist}`);
      }

      // Add generic options for variety
      variations.push('Similar musical style and energy');
      variations.push('Shares the same wavelength');
      variations.push('Comparable mood and tempo');
      variations.push('Similar vibes and atmosphere');

      fallback = variations[Math.floor(Math.random() * variations.length)];

      // ALWAYS append danceability and mood scores to the fallback
      if (hasDanceability && hasMood) {
        fallback += ` (Danceability: ${recommendation.danceability}/10, Mood: ${recommendation.mood}/10)`;
      } else if (hasDanceability) {
        fallback += ` (Danceability: ${recommendation.danceability}/10)`;
      } else if (hasMood) {
        fallback += ` (Mood: ${recommendation.mood}/10)`;
      }
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
        previewUrl: r.previewUrl,
        danceability: r.danceability,
        mood: r.mood
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

// Debug endpoint to verify OAuth setup
app.get('/api/debug/oauth', (req, res) => {
  res.json({
    redirectUri: REDIRECT_URI,
    clientIdConfigured: !!SPOTIFY_CLIENT_ID,
    clientSecretConfigured: !!SPOTIFY_CLIENT_SECRET,
    endpoints: {
      login: '/auth/login',
      callback: '/auth/callback',
      authStatus: '/api/auth-status',
      createPlaylist: '/api/create-playlist'
    }
  });
});

// Spotify OAuth - Step 1: Redirect user to Spotify login
app.get('/auth/login', (req, res) => {
  console.log('🔐 OAuth login initiated');
  console.log('Redirect URI:', REDIRECT_URI);
  console.log('Client ID configured:', !!SPOTIFY_CLIENT_ID);

  const scope = 'playlist-modify-public playlist-modify-private';
  const authUrl = `https://accounts.spotify.com/authorize?` +
    `response_type=code&client_id=${SPOTIFY_CLIENT_ID}&scope=${encodeURIComponent(scope)}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

  console.log('Redirecting to Spotify:', authUrl.substring(0, 100) + '...');
  res.redirect(authUrl);
});

// Spotify OAuth - Step 2: Handle callback and exchange code for token
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;

  if (!code) {
    return res.send('<script>window.close();</script>');
  }

  try {
    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');

    const bodyParams = new URLSearchParams();
    bodyParams.append('grant_type', 'authorization_code');
    bodyParams.append('code', code);
    bodyParams.append('redirect_uri', REDIRECT_URI);

    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authBuffer}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: bodyParams
    });

    if (!response.ok) {
      throw new Error('Failed to exchange code for token');
    }

    const data = await response.json();

    // Get user profile to get user ID
    const profileResponse = await fetch('https://api.spotify.com/v1/me', {
      headers: { 'Authorization': `Bearer ${data.access_token}` }
    });
    const profile = await profileResponse.json();

    // Generate session ID and store
    const sessionId = Math.random().toString(36).substring(2);
    userSessions.set(sessionId, {
      accessToken: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
      userId: profile.id
    });

    // Send session ID to client via cookie and close popup
    res.send(`
      <script>
        localStorage.setItem('wavelength_session', '${sessionId}');
        window.opener.postMessage({ type: 'auth-success', sessionId: '${sessionId}' }, '*');
        window.close();
      </script>
    `);
  } catch (error) {
    console.error('OAuth error:', error);
    res.send('<script>alert("Authentication failed"); window.close();</script>');
  }
});

// Check auth status
app.get('/api/auth-status', (req, res) => {
  const sessionId = req.headers['x-session-id'];

  if (!sessionId) {
    return res.json({ authenticated: false });
  }

  const session = userSessions.get(sessionId);

  if (!session || session.expiresAt < Date.now()) {
    if (session) userSessions.delete(sessionId);
    return res.json({ authenticated: false });
  }

  res.json({ authenticated: true, userId: session.userId });
});

// Create playlist with recommendations
app.post('/api/create-playlist', async (req, res) => {
  const sessionId = req.headers['x-session-id'];
  const { playlistName, trackUris } = req.body;

  if (!sessionId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  const session = userSessions.get(sessionId);

  if (!session || session.expiresAt < Date.now()) {
    if (session) userSessions.delete(sessionId);
    return res.status(401).json({ error: 'Session expired' });
  }

  if (!playlistName || !trackUris || !Array.isArray(trackUris)) {
    return res.status(400).json({ error: 'Missing playlist name or track URIs' });
  }

  try {
    // Create playlist
    const createResponse = await fetch(`https://api.spotify.com/v1/users/${session.userId}/playlists`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: playlistName,
        description: 'Created with Wavelength - Music Discovery',
        public: false
      })
    });

    if (!createResponse.ok) {
      throw new Error('Failed to create playlist');
    }

    const playlist = await createResponse.json();

    // Add tracks to playlist
    const addTracksResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ uris: trackUris })
    });

    if (!addTracksResponse.ok) {
      throw new Error('Failed to add tracks to playlist');
    }

    res.json({
      success: true,
      playlistId: playlist.id,
      playlistUrl: playlist.external_urls.spotify
    });

  } catch (error) {
    console.error('Playlist creation error:', error);
    res.status(500).json({ error: 'Failed to create playlist' });
  }
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