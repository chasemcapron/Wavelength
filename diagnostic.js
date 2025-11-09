import 'dotenv/config';

// Test your Spotify credentials
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

console.log('=== Spotify API Diagnostic Tool ===\n');

// Check if credentials exist
console.log('1. Checking environment variables...');
console.log('   SPOTIFY_CLIENT_ID:', SPOTIFY_CLIENT_ID ? `Present (${SPOTIFY_CLIENT_ID.substring(0, 8)}...)` : '❌ MISSING');
console.log('   SPOTIFY_CLIENT_SECRET:', SPOTIFY_CLIENT_SECRET ? `Present (${SPOTIFY_CLIENT_SECRET.substring(0, 8)}...)` : '❌ MISSING');

if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.error('\n❌ ERROR: Missing credentials in .env file');
  console.error('Make sure your .env file contains:');
  console.error('SPOTIFY_CLIENT_ID=your_client_id');
  console.error('SPOTIFY_CLIENT_SECRET=your_client_secret');
  process.exit(1);
}

async function runDiagnostics() {
  try {
    // Step 1: Get token
    console.log('\n2. Requesting access token...');
    const authBuffer = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
    
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${authBuffer}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    if (!tokenResponse.ok) {
      const error = await tokenResponse.text();
      console.error('   ❌ Token request failed:', tokenResponse.status, error);
      console.error('\n   This usually means:');
      console.error('   - Your Client ID or Secret is incorrect');
      console.error('   - Your credentials have been revoked');
      console.error('   - Check your Spotify Developer Dashboard: https://developer.spotify.com/dashboard');
      return;
    }

    const tokenData = await tokenResponse.json();
    const token = tokenData.access_token;
    console.log('   ✅ Token obtained successfully');
    console.log('   Token preview:', token.substring(0, 20) + '...');

    // Step 2: Test a simple endpoint
    console.log('\n3. Testing /tracks endpoint...');
    const testTrackId = '2X485T9Z5Ly0xyaghN73ed'; // "Let It Happen" by Tame Impala
    
    const trackResponse = await fetch(`https://api.spotify.com/v1/tracks/${testTrackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!trackResponse.ok) {
      console.error('   ❌ Track request failed:', trackResponse.status);
      const error = await trackResponse.text();
      console.error('   Error:', error);
    } else {
      const trackData = await trackResponse.json();
      console.log('   ✅ Track endpoint working');
      console.log('   Found:', trackData.name, 'by', trackData.artists[0].name);
    }

    // Step 3: Test audio-features with singular endpoint
    console.log('\n4. Testing /audio-features/{id} endpoint (singular)...');
    const featuresResponse1 = await fetch(`https://api.spotify.com/v1/audio-features/${testTrackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!featuresResponse1.ok) {
      console.error('   ❌ Audio features (singular) failed:', featuresResponse1.status);
      const error = await featuresResponse1.text();
      console.error('   Error:', error);
      console.error('\n   ⚠️  This is the problem! Your credentials may not have access to audio features.');
      console.error('   Solutions:');
      console.error('   1. Regenerate your Client Secret in the Spotify Dashboard');
      console.error('   2. Create a new app in the Spotify Developer Dashboard');
      console.error('   3. Ensure you\'re using Client Credentials flow (not other OAuth flows)');
    } else {
      const featuresData = await featuresResponse1.json();
      console.log('   ✅ Audio features (singular) working');
      console.log('   Valence:', featuresData.valence);
      console.log('   Tempo:', featuresData.tempo);
    }

    // Step 4: Test audio-features with plural endpoint
    console.log('\n5. Testing /audio-features?ids={id} endpoint (plural)...');
    const featuresResponse2 = await fetch(`https://api.spotify.com/v1/audio-features?ids=${testTrackId}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (!featuresResponse2.ok) {
      console.error('   ❌ Audio features (plural) failed:', featuresResponse2.status);
      const error = await featuresResponse2.text();
      console.error('   Error:', error);
    } else {
      const featuresData = await featuresResponse2.json();
      console.log('   ✅ Audio features (plural) working');
      console.log('   Valence:', featuresData.audio_features[0].valence);
    }

    console.log('\n=== Diagnostic Complete ===');
    
  } catch (error) {
    console.error('\n❌ Unexpected error:', error.message);
    console.error(error);
  }
}

runDiagnostics();