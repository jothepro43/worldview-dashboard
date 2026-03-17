/**
 * Test script for rate limiting and caching
 * Tests the /api/opensky and /api/adsbfi endpoints
 */

const BASE_URL = 'http://localhost:3000';

// Test parameters
const testCases = [
    {
        name: 'OpenSky - Cache Hit Test',
        endpoint: '/api/opensky',
        params: { lamin: '40', lomin: '-74', lamax: '41', lomax: '-73' },
        description: 'Make same request 3 times - should cache on 2nd and 3rd'
    },
    {
        name: 'ADSBFI - Cache Hit Test',
        endpoint: '/api/adsbfi',
        params: { lat: '40.7128', lon: '-74.0060', radius: '250' },
        description: 'Make same request 3 times - should cache on 2nd and 3rd'
    },
    {
        name: 'OpenSky - Throttle Test',
        endpoint: '/api/opensky',
        params: { lamin: '40', lomin: '-74', lamax: '41', lomax: '-73' },
        description: 'Make rapid requests within 1 second - should get throttled',
        rapid: true,
        count: 3
    },
    {
        name: 'ADSBFI - Throttle Test',
        endpoint: '/api/adsbfi',
        params: { lat: '40.7128', lon: '-74.0060', radius: '250' },
        description: 'Make rapid requests within 1.5 seconds - should get throttled',
        rapid: true,
        count: 3
    }
];

async function makeRequest(endpoint, params) {
    const queryString = new URLSearchParams(params).toString();
    const url = `${BASE_URL}${endpoint}?${queryString}`;
    
    try {
        const response = await fetch(url, { timeout: 5000 });
        const data = await response.json();
        
        return {
            status: response.status,
            statusText: response.statusText,
            cached: data._cached || false,
            error: data.error || null,
            headers: {
                rateLimitRemaining: response.headers.get('X-Rate-Limit-Remaining'),
                rateLimitRetryAfter: response.headers.get('X-Rate-Limit-Retry-After-Seconds')
            }
        };
    } catch (err) {
        return {
            status: 0,
            error: err.message,
            cached: false
        };
    }
}

async function runTest(testCase) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`📋 TEST: ${testCase.name}`);
    console.log(`${'='.repeat(70)}`);
    console.log(`Description: ${testCase.description}`);
    console.log(`Endpoint: ${testCase.endpoint}`);
    console.log(`Params: ${JSON.stringify(testCase.params)}`);
    
    if (testCase.rapid) {
        console.log(`\n⚡ Rapid test - making ${testCase.count} requests rapidly...\n`);
        
        for (let i = 0; i < testCase.count; i++) {
            const result = await makeRequest(testCase.endpoint, testCase.params);
            console.log(`Request ${i + 1}:`);
            console.log(`  Status: ${result.status} ${result.statusText || ''}`);
            console.log(`  Cached: ${result.cached}`);
            if (result.error) console.log(`  Error: ${result.error}`);
            if (result.headers.rateLimitRemaining) {
                console.log(`  Rate Limit Remaining: ${result.headers.rateLimitRemaining}`);
            }
        }
    } else {
        console.log(`\n📍 Making 3 sequential requests to test caching...\n`);
        
        for (let i = 0; i < 3; i++) {
            const result = await makeRequest(testCase.endpoint, testCase.params);
            console.log(`Request ${i + 1}:`);
            console.log(`  Status: ${result.status} ${result.statusText || ''}`);
            console.log(`  Cached: ${result.cached}`);
            if (result.error) console.log(`  Error: ${result.error}`);
            if (result.headers.rateLimitRemaining) {
                console.log(`  Rate Limit Remaining: ${result.headers.rateLimitRemaining}`);
            }
            
            // Wait 100ms between requests to avoid throttling
            if (i < 2) await new Promise(r => setTimeout(r, 100));
        }
    }
}

async function runAllTests() {
    console.log(`\n${'*'.repeat(70)}`);
    console.log('* Rate Limiting & Caching Test Suite');
    console.log('*'.repeat(70));
    console.log(`\nServer: ${BASE_URL}`);
    console.log(`Started: ${new Date().toISOString()}`);
    
    for (const testCase of testCases) {
        try {
            await runTest(testCase);
        } catch (err) {
            console.error(`\n❌ Test failed with error: ${err.message}`);
        }
    }
    
    console.log(`\n${'*'.repeat(70)}`);
    console.log('* Test Suite Complete');
    console.log('*'.repeat(70));
    console.log(`Finished: ${new Date().toISOString()}\n`);
}

// Polyfill for fetch and URLSearchParams if needed (for Node < 18)
if (typeof fetch === 'undefined') {
    global.fetch = (await import('node-fetch')).default;
}

runAllTests().catch(console.error);
