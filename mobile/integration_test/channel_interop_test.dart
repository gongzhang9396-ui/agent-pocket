import 'dart:convert';
import 'dart:io';

import 'package:app/protocol/relay_phone_channel.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('Flutter channel exchanges ordered messages with the real Node Host', () async {
    final sodium = await SodiumSumoInit.init();
    final http = HttpClient();
    Future<Map<String, dynamic>> call(String path, [Map<String, dynamic>? body]) async {
      final uri = Uri.parse('http://127.0.0.1:49322$path');
      final request = body == null ? await http.getUrl(uri) : await http.postUrl(uri);
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.write(jsonEncode(body));
      }
      final response = await request.close();
      final text = await utf8.decoder.bind(response).join();
      if (response.statusCode != 200) throw StateError('fixture failed: $text');
      return jsonDecode(text) as Map<String, dynamic>;
    }

    final fixture = await call('/fixture');
    final opened = await RelayPhoneChannel.open(sodium,
      fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>,
      'fixture-${DateTime.now().microsecondsSinceEpoch}', firstMessage: 'hello');
    try {
      final response = await call('/open', opened.envelope);
      await opened.channel.accept(response);
      await expectLater(opened.channel.encrypt('out of order'), throwsStateError);
      final firstReply = await call('/message', await opened.channel.takeFirstEnvelope());
      expect(await opened.channel.decrypt(firstReply), 'host received: hello');
      await expectLater(opened.channel.takeFirstEnvelope(), throwsStateError);
      final secondReply = await call('/message', await opened.channel.encrypt('中文与 emoji 🌿'));
      expect(await opened.channel.decrypt(secondReply), 'host received: 中文与 emoji 🌿');
      final closeReply = await call('/message', await opened.channel.encrypt('bye', finalMessage: true));
      expect(await opened.channel.decrypt(closeReply), 'host received: bye');
      await expectLater(opened.channel.encrypt('too late'), throwsStateError);
    } finally {
      await opened.channel.dispose();
      http.close(force: true);
    }
  }, timeout: const Timeout(Duration(seconds: 30)));
}
