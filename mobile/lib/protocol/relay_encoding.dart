import 'dart:convert';
import 'dart:typed_data';

Uint8List relayAad(Map<String, dynamic> envelope) => Uint8List.fromList(utf8.encode(jsonEncode([
  envelope['accountId'], envelope['hostId'], envelope['deviceId'], envelope['channelId'],
  envelope['counter'], envelope['kind'], envelope['eventId'], envelope['eventType'],
])));

Uint8List handshakeBytes(Map<String, dynamic> message) {
  final keys = message.keys.toList()..sort();
  return Uint8List.fromList(utf8.encode(jsonEncode([for (final key in keys) [key, message[key]]])));
}

Uint8List transcript(String account, String host, String device, String channel) =>
  Uint8List.fromList(utf8.encode('agent-pocket-relay-v2\u0000$account\u0000$host\u0000$device\u0000$channel'));
