// Synthetic, loopback-only fixture for Flutter/Node protocol interoperability.
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createHostIdentity, HostChannelCrypto } from '../../bridge/src/relay-crypto.ts';
import { AttachmentTransfers } from '../../bridge/src/attachment-transfers.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const require = createRequire(new URL('../../bridge/package.json', import.meta.url));
const sodium = require('libsodium-wrappers-sumo');
const { WebSocketServer } = require('ws');
await sodium.ready;
const b64 = bytes => Buffer.from(bytes).toString('base64url');
const identity = await createHostIdentity('https://example.invalid', 'Fixture');
identity.accountId = 'fixture-account';
identity.hostId = 'fixture-host';
const signing = sodium.crypto_sign_keypair();
const encryption = sodium.crypto_box_keypair();
const peer = { id: 'fixture-device', signingPublicKey: b64(signing.publicKey), encryptionPublicKey: b64(encryption.publicKey) };
const credentials = {
  accountId: identity.accountId, deviceId: peer.id, deviceStatus: 'approved', contentKey: b64(sodium.randombytes_buf(32)),
  deviceSigningPrivateKey: b64(signing.privateKey), deviceEncryptionPrivateKey: b64(encryption.privateKey),
  deviceEncryptionPublicKey: peer.encryptionPublicKey,
};
const host = { id: identity.hostId, signingPublicKey: identity.signingPublicKey, encryptionPublicKey: identity.encryptionPublicKey };
const sampleFile = Buffer.alloc(200000, 0x4b);
const uploadRoot = await mkdtemp(join(tmpdir(), 'pocket-dart-uploads-'));
const transfers = new AttachmentTransfers(join(uploadRoot, 'uploads'));
const operations = new Map();
const updateKeys = sodium.crypto_sign_keypair(), updateBytes = Buffer.alloc(512 * 1024, 42);
const updateManifest = JSON.stringify({ schemaVersion: 1, platform: 'android', version: '0.4.0', versionCode: 400,
  asset: { name: 'Agent-Pocket-0.4.0-release.apk', size: updateBytes.length, sha256: createHash('sha256').update(updateBytes).digest('hex') } });
const updateResponse = { manifestJson: updateManifest, manifestSignature: Buffer.from(sodium.crypto_sign_detached(Buffer.from(updateManifest), updateKeys.privateKey)).toString('base64'),
  downloadUrl: 'https://example.invalid/api/updates/android/0.4.0/Agent-Pocket-0.4.0-release.apk' };
const updatePublicKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(updateKeys.publicKey)]).toString('base64');
async function replyFor(text) {
  try {
    const request = JSON.parse(text);
    if (request.jsonrpc === '2.0') {
      if (request.method.startsWith('attachment/')) {
        const action = request.method.split('/')[1], params = request.params;
        const result = action === 'begin' ? await transfers.begin(peer.id, params, { cwd: params.cwd || 'fixture-project', ...(params.threadId ? { threadId: params.threadId } : {}) })
          : await transfers[action](peer.id, params);
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result });
      }
      if (request.method === 'thread/start') {
        const params = request.params;
        if (!operations.has(params.operationId)) {
          if (params.attachmentIds) await transfers.claim(peer.id, params.attachmentIds, params.operationId, { cwd: params.cwd });
          operations.set(params.operationId, { operationId: params.operationId, status: 'succeeded', result: { thread: { id: `created-${operations.size + 1}` } } });
        }
        return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: operations.get(params.operationId).result });
      }
      const payload = request.method === 'bridge/hello'
        ? { protocolVersion: 1, hostId: 'fixture-local-bridge-id', deviceId: peer.id, capabilities: ['artifacts-v1', 'attachments-v2'] }
        : request.method === 'thread/list' ? { data: [{ id: 'fixture-thread' }], nextCursor: null }
        : request.method === 'thread/read' ? { thread: { id: request.params.threadId, turns: [] }, page: { hasMore: false } }
        : request.method === 'artifact/list' ? { data: [{ id: 'fixture-file', name: 'fixture.txt', mimeType: 'text/plain',
          size: sampleFile.length, messageId: 'turn:reply', source: 'fixture.txt' }] }
        : request.method === 'artifact/read' ? (() => {
          const offset = request.params.offset;
          const end = Math.min(offset + 192 * 1024, sampleFile.length);
          return { id: 'fixture-file', offset, size: sampleFile.length, nextOffset: end,
            done: end === sampleFile.length, data: sampleFile.subarray(offset, end).toString('base64') };
        })()
        : request.method === 'operation/get' ? operations.get(request.params.operationId) || { operationId: request.params.operationId, status: 'missing' }
        : { data: [] };
      return JSON.stringify({ jsonrpc: '2.0', id: request.id, result: payload });
    }
  } catch (error) {
    try { const request = JSON.parse(text); if (request.jsonrpc === '2.0') return JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: error.nameCode || 'FIXTURE_ERROR', message: error.message } }); }
    catch { /* The channel vector test uses plain text. */ }
  }
  return `host received: ${text}`;
}
let channel;
const server = createServer(async (request, response) => {
  try {
    let result;
    if (request.method === 'GET' && request.url === '/update-fixture') {
      result = { updatePublicKey, updateResponse };
    } else if (request.url.startsWith('/api/updates/android/')) {
      if (request.headers.authorization !== 'Bearer fixture-update-new') {
        response.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'AUTH_FAILED', message: 'fixture expired' } })); return;
      }
      if (request.url.endsWith('/latest')) result = updateResponse;
      else {
        response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': updateBytes.length });
        for (let offset = 0; offset < updateBytes.length; offset += 32768) response.write(updateBytes.subarray(offset, offset + 32768));
        response.end(); return;
      }
    } else if (request.method === 'GET' && request.url === '/fixture') {
      result = { credentials, host };
    } else if (request.method === 'POST' && ['/open', '/message'].includes(request.url)) {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
        if (body.length > 2_000_000) throw new Error('request too large');
      }
      const envelope = JSON.parse(body);
      if (request.url === '/open') {
        const accepted = await HostChannelCrypto.accept(identity, envelope, peer);
        channel = accepted.channel;
        result = accepted.response;
      } else {
        if (!channel) throw new Error('channel not open');
        const final = envelope.kind === 'channel.close';
        const text = channel.decrypt(envelope, final);
        result = channel.encrypt(await replyFor(text), final);
      }
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: String(error) }));
  }
});
const sockets = new WebSocketServer({ server, path: '/ws/device', maxPayload: 2_000_000 });
sockets.on('connection', (socket, request) => {
  if (request.headers.authorization !== 'Bearer fixture-access') { socket.close(4003); return; }
  let active;
  socket.on('message', async raw => {
    let message;
    try {
      message = JSON.parse(raw.toString());
      let result;
      if (message.method === 'relay/hello') result = { protocolVersion: 2, accountId: identity.accountId, deviceId: peer.id };
      else if (message.method === 'host/list') result = [{ ...host, name: 'Fixture', online: true }];
      else if (message.method === 'channel/open') {
        const accepted = await HostChannelCrypto.accept(identity, message.params.envelope, peer);
        active = accepted.channel;
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'channel/open', params: { envelope: accepted.response } }));
        result = { forwarded: true };
      } else if (message.method === 'channel/data') {
        const reply = active.encrypt(await replyFor(active.decrypt(message.params.envelope)));
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'channel/data', params: { envelope: reply } }));
        result = { forwarded: true };
      } else if (message.method === 'channel/close') {
        active.decrypt(message.params.envelope, true);
        result = { forwarded: true };
      } else throw new Error('unsupported fixture method');
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
    } catch (error) {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: message?.id, error: { code: 'FIXTURE_ERROR', message: String(error) } }));
    }
  });
});
server.listen(49322, '127.0.0.1', () => console.log('fixture ready'));
process.on('SIGINT', async () => { server.close(); await rm(uploadRoot, { recursive: true, force: true }); process.exit(0); });
