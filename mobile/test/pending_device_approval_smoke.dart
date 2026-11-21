// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import '../lib/session/pending_device_approval.dart';
import '../lib/session/session_manager.dart';
import 'existing_device_login_smoke.dart' show original, open;
import 'session_contract_smoke.dart' show MemoryStore;

Map<String, dynamic> status(String state, {String id = 'device'}) => {
  'account': {'id': 'account', 'signingPublicKey': 'account-sign', 'encryptionPublicKey': 'account-box'},
  'device': {'id': id, 'status': state, 'keyPackage': 'sealed'},
};

Future<void> main() async {
  final initial = {...original(), 'deviceStatus': 'pending', 'requiresLogin': false,
    'accessExpiresAt': 100000, 'refreshExpiresAt': 900000};
  final store = MemoryStore(initial);
  final sessions = SessionManager(store, (_) async => throw StateError('unexpected rotation'), now: () => 1000);
  final ref = await sessions.snapshot(approvedOnly: false);
  var state = 'pending';
  final poller = PendingDeviceApproval(sessions, open, request: (uri, token) async {
    assert(uri.toString() == 'https://example.invalid/root/api/device/status' && token == 'old');
    return status(state);
  });
  assert(!await poller.poll(ref));
  assert(store.value!['deviceStatus'] == 'pending');
  state = 'approved';
  assert(await poller.poll(ref));
  assert(store.value!['deviceStatus'] == 'approved' && store.value!['contentKey'] == 'new-content');

  final otherStore = MemoryStore(initial);
  final other = SessionManager(otherStore, (_) async => {}, now: () => 1000);
  final otherRef = await other.snapshot(approvedOnly: false);
  final mismatch = PendingDeviceApproval(other, open, request: (_, _) async => status('approved', id: 'other'));
  try { await mismatch.poll(otherRef); throw StateError('other device accepted'); }
  on FormatException { assert(otherStore.value!['deviceStatus'] == 'pending'); }

  final gate = Completer<Map<String, dynamic>>();
  final delayed = PendingDeviceApproval(other, open, request: (_, _) => gate.future);
  final pending = delayed.poll(otherRef);
  await Future<void>.delayed(Duration.zero);
  await other.clear();
  gate.complete(status('approved'));
  try { await pending; throw StateError('late approval restored logged-out identity'); }
  on SessionChanged { assert(otherStore.value == null); }

  final expiredStore = MemoryStore(initial);
  var refreshes = 0;
  var reads = 0;
  final expired = SessionManager(expiredStore, (_) async {
    refreshes++;
    return {'accessToken': 'new', 'refreshToken': 'new-refresh', 'accessExpiresAt': 100000, 'refreshExpiresAt': 900000};
  }, now: () => 1000);
  final expiredRef = await expired.snapshot(approvedOnly: false);
  final retry = PendingDeviceApproval(expired, open, request: (_, token) async {
    reads++;
    if (token == 'old') throw AccessRejected();
    return status('approved');
  });
  assert(await retry.poll(expiredRef));
  assert(reads == 2 && refreshes == 1 && expiredStore.value!['accessToken'] == 'new');
  print('pending device approval contract passed');
}
