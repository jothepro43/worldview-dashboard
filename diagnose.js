/**
 * Diagnostic script to test rate limiting and caching on localhost:3000
 * Run with: node diagnose.js
 */

const http = require('http');
const https = require('https');

const BASE_URL = 'http://localhost:3000';

// Utility to make HTTP requests
function makeRequest(url) {
    return new Promise((resolve, reject) => {
        const protocol = url.startsWith('https') ? https : http;
        
        protocol.get(url, { timeout: 10000 }, (res) => {
            let data = '';
            
            res.on('data', chunk => {
                data += chunk;
            });
            
            res.on('end', () => {
                try {
                    resolve({
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        headers: res.headers,
                        data: data ? JSON.parse(data) : null
                    });
                } catch (e) {
                    resolve({
                        status: res.statusCode,
                        statusText: res.statusMessage,
                        headers: res.headers,
                        data: data
                    });
                }
            });
        }).on('error', reject);
    });
}

async function checkServerHealth() {
    console.log('\n' + '='.repeat(70));
    console.log('🏥 SERVER HEALTH CHECK');
    console.log('='.repeat(70));
    
    try {
        const result = await makeRequest(`${BASE_URL}/api/health`);
        console.log('✅ Server is running');
        console.log(`   Status: ${result.status}`);
        console.log(`   Data: ${JSON.stringify(result.data, null, 2)}`);
        return true;
    } catch (err) {
        console.log('❌ Server is NOT responding');
        console.log(`   Error: ${err.message}`);
        return false;
    }
}

async function testOpenSkyEndpoint() {
    console.log('\n' + '='.repeat(70));
    console.log('🛰️  OPENSKY ENDPOINT TEST');
    console.log('='.repeat(70));
    
    const params = new URLSearchParams({
        lamin: '40',
        lomin: '-74',
        lamax: '41',
        lomax: '-73'
    }).toString();
    
    const url = `${BASE_URL}/api/opensky?${params}`;
    console.log(`\nMaking request to: ${url}`);
    
    try {
        const result = await makeRequest(url);
        console.log(`\n📊 Response Status: ${result.status} ${result.statusText}`);
        
        console.log('\n📋 Response Headers:');
        console.log(`   Content-Type: ${result.headers['content-type']}`);
        console.log(`   X-Rate-Limit-Remaining: ${result.headers['x-rate-limit-remaining'] || 'NOT SET'}`);
        console.log(`   X-Rate-Limit-Retry-After-Seconds: ${result.headers['x-rate-limit-retry-after-seconds'] || 'NOT SET'}`);
        
        console.log('\n📦 Response Body:');
        
        if (result.data) {
            if (result.data.error) {
                console.log(`   ❌ ERROR: ${result.data.error}`);
                if (result.data.message) console.log(`   Message: ${result.data.message}`);
                if (result.data.retryAfterSeconds) console.log(`   Retry After: ${result.data.retryAfterSeconds}s`);
            } else if (result.data.states) {
                console.log(`   ✅ Got aircraft data`);
                console.log(`   Number of states: ${result.data.states.length}`);
                console.log(`   Auth mode: ${result.data._authMode || 'Unknown'}`);
                console.log(`   Cached: ${result.data._cached ? 'YES' : 'NO'}`);
            } else {
                console.log(`   Data: ${JSON.stringify(result.data, null, 2).substring(0, 200)}...`);
            }
        }
        
        return result;
    } catch (err) {
        console.log(`❌ Request failed: ${err.message}`);
        return null;
    }
}

async function testADSBfiEndpoint() {
    console.log('\n' + '='.repeat(70));
    console.log('✈️  ADSBFI ENDPOINT TEST');
    console.log('='.repeat(70));
    
    const params = new URLSearchParams({
        lat: '40.7128',
        lon: '-74.0060',
        radius: '250'
    }).toString();
    
    const url = `${BASE_URL}/api/adsbfi?${params}`;
    console.log(`\nMaking request to: ${url}`);
    
    try {
        const result = await makeRequest(url);
        console.log(`\n📊 Response Status: ${result.status} ${result.statusText}`);
        
        console.log('\n📋 Response Headers:');
        console.log(`   Content-Type: ${result.headers['content-type']}`);
        
        console.log('\n📦 Response Body:');
        
        if (result.data) {
            if (result.data.error) {
                console.log(`   ❌ ERROR: ${result.data.error}`);
                if (result.data.message) console.log(`   Message: ${result.data.message}`);
            } else if (Array.isArray(result.data.aircraft)) {
                console.log(`   ✅ Got aircraft data`);
                console.log(`   Number of aircraft: ${result.data.aircraft.length}`);
                console.log(`   Cached: ${result.data._cached ? 'YES' : 'NO'}`);
            } else if (result.data.ac && Array.isArray(result.data.ac)) {
                console.log(`   ✅ Got aircraft data (alternate format)`);
                console.log(`   Number of aircraft: ${result.data.ac.length}`);
                console.log(`   Cached: ${result.data._cached ? 'YES' : 'NO'}`);
            } else {
                console.log(`   Data: ${JSON.stringify(result.data, null, 2).substring(0, 200)}...`);
            }
        }
        
        return result;
    } catch (err) {
        console.log(`❌ Request failed: ${err.message}`);
        return null;
    }
}

async function testCaching() {
    console.log('\n' + '='.repeat(70));
    console.log('💾 CACHING TEST (3 rapid requests)');
    console.log('='.repeat(70));
    
    const params = new URLSearchParams({
        lamin: '40',
        lomin: '-74',
        lamax: '41',
        lomax: '-73'
    }).toString();
    
    const url = `${BASE_URL}/api/opensky?${params}`;
    
    for (let i = 1; i <= 3; i++) {
        try {
            const start = Date.now();
            const result = await makeRequest(url);
            const duration = Date.now() - start;
            
            console.log(`\nRequest ${i}:`);
            console.log(`   Status: ${result.status}`);
            console.log(`   Cached: ${result.data?._cached ? '✅ YES' : '❌ NO'}`);
            console.log(`   Duration: ${duration}ms`);
            
            if (result.data?.error) {
                console.log(`   Error: ${result.data.error}`);
            }
        } catch (err) {
            console.log(`\nRequest ${i}: ❌ ${err.message}`);
        }
    }
}

async function testThrottling() {
    console.log('\n' + '='.repeat(70));
    console.log('⏱️  THROTTLING TEST (2 requests within 500ms)');
    console.log('='.repeat(70));
    
    const params = new URLSearchParams({
        lamin: '40',
        lomin: '-74',
        lamax: '41',
        lomax: '-73'
    }).toString();
    
    const url = `${BASE_URL}/api/opensky?${params}`;
    
    console.log('\nMaking 2 requests back-to-back (<100ms apart)...');
    
    try {
        const start1 = Date.now();
        const result1 = await makeRequest(url);
        const duration1 = Date.now() - start1;
        
        console.log(`\nRequest 1:`);
        console.log(`   Status: ${result1.status}`);
        console.log(`   Duration: ${duration1}ms`);
        console.log(`   Cached: ${result1.data?._cached ? 'YES' : 'NO'}`);
        
        // Immediate second request (should be throttled)
        const start2 = Date.now();
        const result2 = await makeRequest(url);
        const duration2 = Date.now() - start2;
        
        console.log(`\nRequest 2 (immediate):`);
        console.log(`   Status: ${result2.status}`);
        console.log(`   Duration: ${duration2}ms`);
        
        if (result2.status === 429) {
            console.log(`   ✅ Correctly throttled (429)`);
            console.log(`   Error: ${result2.data?.error}`);
            console.log(`   Message: ${result2.data?.message}`);
        } else {
            console.log(`   ❌ Should have been throttled but wasn't`);
            console.log(`   Cached: ${result2.data?._cached ? 'YES' : 'NO'}`);
        }
    } catch (err) {
        console.log(`❌ Test failed: ${err.message}`);
    }
}

async function runDiagnostics() {
    console.log('\n');
    console.log('╔' + '═'.repeat(68) + '╗');
    console.log('║' + ' '.repeat(15) + 'RATE LIMITING DIAGNOSTICS' + ' '.repeat(28) + '║');
    console.log('╚' + '═'.repeat(68) + '╝');
    console.log(`Server URL: ${BASE_URL}`);
    console.log(`Started: ${new Date().toISOString()}\n`);
    
    // Check if server is running
    const serverRunning = await checkServerHealth();
    
    if (!serverRunning) {
        console.log('\n⚠️  Cannot proceed - server is not responding.');
        console.log('Please ensure the server is running with: npm start');
        process.exit(1);
    }
    
    // Run tests
    await testOpenSkyEndpoint();
    await testADSBfiEndpoint();
    await testCaching();
    await testThrottling();
    
    console.log('\n' + '═'.repeat(70));
    console.log('✅ DIAGNOSTICS COMPLETE');
    console.log('═'.repeat(70) + '\n');
}

runDiagnostics().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
