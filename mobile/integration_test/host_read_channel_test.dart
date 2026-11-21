import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:app/protocol/host_read_channel.dart';
import 'package:app/tasks/task_catalog.dart';
import 'package:app/protocol/rpc_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:sodium/sodium_sumo.dart';

class FixtureOuter implements HostOuterTransport {
  FixtureOuter({this.tamperOpen = false, this.dropReply = false});
  final bool tamperOpen;
  bool dropReply;
  int dataCalls = 0;
  final HttpClient http = HttpClient();
  final StreamController<Map<String, dynamic>> controller = StreamController.broadcast();
  @override Stream<Map<String, dynamic>> get events => controller.stream;
  Future<Map<String, dynamic>> request(String path, [Map<String, dynamic>? body]) async {
    final uri = Uri.parse('http://127.0.0.1:49322$path');
    final request = body == null ? await http.getUrl(uri) : await http.postUrl(uri);
    if (body != null) { request.headers.contentType = ContentType.json; request.write(jsonEncode(body)); }
    final response = await request.close();
    final text = await utf8.decoder.bind(response).join();
    if (response.statusCode != 200) throw StateError('fixture failed: $text');
    return jsonDecode(text) as Map<String, dynamic>;
  }
  @override Future<dynamic> call(String method, [Map<String, dynamic> params = const {}]) async {
    if (method == 'channel/data') dataCalls++;
    final envelope = await request(method == 'channel/open' ? '/open' : '/message', params['envelope'] as Map<String, dynamic>);
    if (method == 'channel/open' && tamperOpen) {
      final ciphertext = envelope['ciphertext'] as String;
      envelope['ciphertext'] = '${ciphertext[0] == 'A' ? 'B' : 'A'}${ciphertext.substring(1)}';
    }
    if (method != 'channel/data' || !dropReply) controller.add({'method': method, 'params': {'envelope': envelope}});
    return {'forwarded': true};
  }
  Future<void> close() async { http.close(force: true); await controller.close(); }
}

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  test('read channel authenticates and reads through the Node Host crypto', () async {
    final sodium = await SodiumSumoInit.init();
    final outer = FixtureOuter();
    final fixture = await outer.request('/fixture');
    final channel = await HostReadChannel.open(sodium, outer,
      fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>,
      'read-${DateTime.now().microsecondsSinceEpoch}');
    try {
      final results = await Future.wait([channel.read('thread/list'), channel.read('project/list')]);
      expect((results.first as Map)['data'][0]['id'], 'fixture-thread');
      expect((results.last as Map)['data'], isEmpty);
      expect((await TaskCatalog(channel.read).load(channel.capabilities)).single['id'], 'fixture-thread');
      await expectLater(channel.read('goal/get', {'threadId': 'fixture-thread'}), throwsStateError);
      await expectLater(channel.read('thread/start'), throwsArgumentError);
    } finally { await channel.close(); await outer.close(); }
  }, timeout: const Timeout(Duration(seconds: 30)));
  test('session change before transmission never submits a mutation envelope', () async {
    final sodium = await SodiumSumoInit.init(), outer = FixtureOuter();
    final fixture = await outer.request('/fixture'); var guardCalls = 0;
    final channel = await HostReadChannel.open(sodium, outer,
      fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>, 'generation-${DateTime.now().microsecondsSinceEpoch}',
      stillCurrent: () => ++guardCalls == 1);
    try {
      final before = outer.dataCalls;
      await expectLater(channel.execute('thread/start', {'cwd': 'fixture', 'text': 'do not send', 'operationId': 'never-sent'}), throwsA(isA<RpcRequestNotSent>()));
      expect(guardCalls, 2); expect(outer.dataCalls, before);
    } finally { await channel.close(); await outer.close(); }
  });

  test('rejects a forged handshake and closes its channel', () async {
    final sodium = await SodiumSumoInit.init();
    final outer = FixtureOuter(tamperOpen: true);
    try {
      final fixture = await outer.request('/fixture');
      await expectLater(HostReadChannel.open(sodium, outer,
        fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>,
        'tampered-${DateTime.now().microsecondsSinceEpoch}', timeout: const Duration(seconds: 3)), throwsA(anything));
    } finally { await outer.close(); }
  }, timeout: const Timeout(Duration(seconds: 15)));

  test('does not retry a missing response', () async {
    final sodium = await SodiumSumoInit.init();
    final outer = FixtureOuter(dropReply: true);
    try {
      final fixture = await outer.request('/fixture');
      await expectLater(HostReadChannel.open(sodium, outer,
        fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>,
        'lost-${DateTime.now().microsecondsSinceEpoch}', timeout: const Duration(seconds: 2)), throwsA(isA<TimeoutException>()));
      expect(outer.dataCalls, 1);
    } finally { await outer.close(); }
  }, timeout: const Timeout(Duration(seconds: 15)));

  test('losing a read response closes the channel without replay', () async {
    final sodium = await SodiumSumoInit.init();
    final outer = FixtureOuter();
    final fixture = await outer.request('/fixture');
    final channel = await HostReadChannel.open(sodium, outer,
      fixture['credentials'] as Map<String, dynamic>, fixture['host'] as Map<String, dynamic>,
      'read-lost-${DateTime.now().microsecondsSinceEpoch}', timeout: const Duration(seconds: 2));
    try {
      outer.dropReply = true;
      await expectLater(channel.read('thread/list'), throwsA(isA<TimeoutException>()));
      await expectLater(channel.read('thread/list'), throwsA(anything));
      expect(outer.dataCalls, 2); // One handshake request and one read.
    } finally { await channel.close(); await outer.close(); }
  }, timeout: const Timeout(Duration(seconds: 15)));
}
