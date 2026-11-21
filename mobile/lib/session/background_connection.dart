import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'pocket_session_service.dart';
import '../protocol/relay_event_feed.dart';

class BackgroundConnection with WidgetsBindingObserver {
  BackgroundConnection(this.service) {
    WidgetsBinding.instance.addObserver(this);
    channel.setMethodCallHandler((call) async {
      if (call.method == 'timeout' || call.method == 'stopped') { _backgroundAllowed = false; await service.feed.stop(); }
    });
    _events = service.feed.updates.listen((event) {
      if (event.type != 'event' || event.value == null) return;
      final value = event.value!;
      if (event.replayed) {
        final at = DateTime.tryParse(value['at'] as String? ?? '');
        if (at == null || DateTime.now().difference(at).abs() > const Duration(minutes: 5)) return;
      }
      if ({'approval.request', 'question.request'}.contains(value['type']) ||
          value['type'] == 'turn.status' && (value['payload'] as Map?)?['status'] == 'completed') {
        unawaited(_attention(event));
      }
    });
  }
  final PocketSessionService service;
  static const channel = MethodChannel('agent_pocket/background');
  StreamSubscription<dynamic>? _events;
  bool _backgroundAllowed = false;
  bool _enabled = false;
  Future<void> _attention(FeedUpdate event) async {
    try {
      final session = await service.sessions.snapshot();
      if (event.sessionGeneration != session.generation || !service.sessions.isCurrent(session)) return;
      await channel.invokeMethod<void>('attention', {'hostId': event.hostId, 'threadId': event.value?['threadId'], 'eventId': event.value?['eventId'],
        'accountId': session.credentials['accountId'], 'deviceId': session.credentials['deviceId']});
    } catch (_) { /* Revoked/expired sessions cannot produce task notifications. */ }
  }
  Future<void> start() async {
    _enabled = true;
    try { _backgroundAllowed = await channel.invokeMethod<bool>('start') ?? false; }
    catch (_) { _backgroundAllowed = false; }
  }
  @override void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && _enabled) {
      unawaited(() async {
        try { await start(); final directory = await service.listHosts(); await service.feed.start(directory.session, directory.hosts); }
        catch (_) { /* Login UI or the normal reconnect loop surfaces failures. */ }
      }());
    } else if (state == AppLifecycleState.paused && !_backgroundAllowed) { unawaited(service.feed.stop()); }
  }
  Future<void> stop() async { _enabled = false; await service.feed.stop(); await channel.invokeMethod<void>('stop'); }
  Future<void> dispose() async { WidgetsBinding.instance.removeObserver(this); await _events?.cancel(); }
}
