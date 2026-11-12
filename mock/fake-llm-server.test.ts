import test from 'ava';
import { requestImageParts } from './fake-llm-server.js';

test('requestImageParts extracts image URLs with their message roles', t => {
  t.deepEqual(requestImageParts({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AQID' } }] },
    { role: 'tool', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image' } }] },
    { role: 'assistant', content: 'text' },
  ] }), [{ role: 'user', url: 'data:image/jpeg;base64,AQID' }, { role: 'tool', url: 'https://example.test/image' }]);
  t.deepEqual(requestImageParts(null), []);
});
