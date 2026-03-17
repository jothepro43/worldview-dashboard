const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Readable } = require('stream');

async function test() {
    try {
        const response = await fetch('https://www.google.com');
        console.log('Body is Node stream:', response.body instanceof Readable);
        
        try {
            const stream = Readable.fromWeb(response.body);
            console.log('Readable.fromWeb succeeded');
        } catch (err) {
            console.log('Readable.fromWeb failed:', err.message);
        }
    } catch (err) {
        console.error('Fetch failed:', err);
    }
}

test();
