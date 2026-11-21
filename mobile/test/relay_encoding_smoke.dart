// These smoke tests run directly with the SDK, independently of native hooks.
// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:convert';
import 'dart:io';
import '../lib/protocol/relay_encoding.dart';

String b64(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');
void main() {
  final vector = jsonDecode(File('../protocol/crypto-vectors.json').readAsStringSync()) as Map<String, dynamic>;
  final metadata = vector['metadata'] as Map<String, dynamic>;
  assert(b64(relayAad(metadata)) == vector['aad']);
  assert(b64(handshakeBytes(vector['ed25519']['handshake'] as Map<String, dynamic>)) == vector['ed25519']['handshakeBytes']);
  assert(b64(transcript(metadata['accountId'], metadata['hostId'], metadata['deviceId'], metadata['channelId'])) == vector['x25519']['transcript']);
  print('relay encoding vectors passed');
}
