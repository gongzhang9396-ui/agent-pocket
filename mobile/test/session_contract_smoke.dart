// These smoke tests run directly with the SDK, independently of native hooks.
// ignore_for_file: avoid_relative_lib_imports, avoid_print
import 'dart:async';
import '../lib/session/session_manager.dart';

class MemoryStore implements CredentialStore {
  Map<String, dynamic>? value;
  bool blocked = false;
  bool failSave = false;
  bool failBlock = false;
  MemoryStore(this.value);
  @override Future<Map<String, dynamic>?> load() async => value == null ? null : {...value!};
  @override Future<bool> isBlocked() async => blocked;
  @override Future<void> block() async { if (failBlock) throw StateError('disk full'); blocked = true; }
  @override Future<void> save(Map<String, dynamic> credentials) async { if (failSave) throw StateError('disk full'); value = {...credentials}; blocked = false; }
  @override Future<void> clearCredentials() async { value = null; blocked = true; }
}

Map<String, dynamic> credential({int expiry = 0, String token = 'old'}) => {
  'endpoint': 'https://example.invalid', 'accountId': 'account', 'deviceId': 'device',
  'deviceStatus': 'approved', 'contentKey': 'key', 'accessToken': token,
  'refreshToken': 'refresh', 'accessExpiresAt': expiry, 'refreshExpiresAt': 900000,
};
Map<String, dynamic> rotated() => {'accessToken': 'new', 'refreshToken': 'next', 'accessExpiresAt': 100000, 'refreshExpiresAt': 900000};

Future<void> main() async {
  final store = MemoryStore(credential());
  final gate = Completer<Map<String, dynamic>>();
  var calls = 0;
  final manager = SessionManager(store, (_) { calls++; return gate.future; }, now: () => 1000);
  final ref = await manager.snapshot();
  final first = manager.fresh(ref);
  final second = manager.fresh(ref);
  await Future<void>.delayed(Duration.zero);
  assert(calls == 1, 'concurrent requests must share rotation');
  gate.complete(rotated());
  assert((await first)['accessToken'] == 'new');
  assert((await second)['accessToken'] == 'new');
  assert(store.value!['refreshToken'] == 'next');

  var readAttempts = 0;
  final result = await manager.read(ref, (value) async {
    readAttempts++;
    if (readAttempts == 1) throw AccessRejected();
    return value['accessToken'];
  });
  assert(result == 'new' && readAttempts == 2);

  final delayed = Completer<Map<String, dynamic>>();
  final oldStore = MemoryStore(credential());
  final oldManager = SessionManager(oldStore, (_) => delayed.future, now: () => 1000);
  final oldRef = await oldManager.snapshot();
  final rotation = oldManager.fresh(oldRef);
  await Future<void>.delayed(Duration.zero);
  await oldManager.clear();
  delayed.complete(rotated());
  try { await rotation; throw StateError('rotation restored logged out session'); }
  on SessionChanged { assert(oldStore.value == null); }

  final interrupted = Completer<Map<String, dynamic>>();
  final interruptedStore = MemoryStore(credential());
  final beforeRestart = SessionManager(interruptedStore, (_) => interrupted.future, now: () => 1000);
  final interruptedRef = await beforeRestart.snapshot();
  final pending = beforeRestart.fresh(interruptedRef);
  await Future<void>.delayed(Duration.zero);
  assert(interruptedStore.blocked);
  final afterRestart = SessionManager(interruptedStore, (_) async => rotated(), now: () => 1000);
  try { await afterRestart.snapshot(); throw StateError('interrupted token rotation was replayed'); }
  on SignInRequired { /* A consumed refresh token is never replayed. */ }
  interrupted.complete(rotated());
  await pending;
  assert(!interruptedStore.blocked);

  final failure = Completer<Map<String, dynamic>>();
  final reloginStore = MemoryStore(credential());
  final relogin = SessionManager(reloginStore, (_) => failure.future, now: () => 1000);
  final prior = await relogin.snapshot();
  final pendingFailure = relogin.fresh(prior);
  await Future<void>.delayed(Duration.zero);
  await relogin.replace(relogin.generation, credential(expiry: 100000, token: 'login'));
  failure.completeError(StateError('delayed network failure'));
  try { await pendingFailure; throw StateError('stale refresh was accepted'); }
  on SessionChanged { assert((await relogin.snapshot()).credentials['accessToken'] == 'login'); }

  final activeGate = Completer<Map<String, dynamic>>();
  final activeStore = MemoryStore(credential(expiry: 100000));
  final active = SessionManager(activeStore, (_) => activeGate.future, now: () => 1000);
  final activeRef = await active.snapshot();
  final rejected = active.fresh(activeRef, rejectedToken: 'old');
  await Future<void>.delayed(Duration.zero);
  var finished = false;
  final concurrent = active.fresh(activeRef).then((value) { finished = true; return value; });
  await Future<void>.delayed(Duration.zero);
  assert(!finished, 'a concurrent consumer must wait for token rotation');
  activeGate.complete(rotated());
  assert((await rejected)['accessToken'] == 'new');
  assert((await concurrent)['accessToken'] == 'new');

  final offlineStore = MemoryStore(credential());
  final offline = SessionManager(offlineStore, (_) async => throw RefreshNotSent(), now: () => 1000);
  final offlineRef = await offline.snapshot();
  try { await offline.fresh(offlineRef); throw StateError('network error swallowed'); }
  on RefreshNotSent { assert(!offlineStore.blocked); }
  assert((await offline.snapshot()).credentials['deviceId'] == 'device');

  final rejectedStore = MemoryStore({...credential(), 'refreshExpiresAt': 0})..failSave = true;
  final expired = SessionManager(rejectedStore, (_) async => rotated(), now: () => 1000);
  final expiredRef = await expired.snapshot();
  try { await expired.fresh(expiredRef); throw StateError('expired credentials accepted'); }
  on SignInRequired { assert(rejectedStore.blocked); }
  final restarted = SessionManager(rejectedStore, (_) async => rotated(), now: () => 1000);
  try { await restarted.snapshot(); throw StateError('expired credentials revived'); }
  on SignInRequired { /* durable block survived failed credential write */ }

  final pendingStore = MemoryStore({...credential(), 'deviceStatus': 'pending', 'contentKey': null});
  final rotationGate = Completer<Map<String, dynamic>>();
  final pendingManager = SessionManager(pendingStore, (_) => rotationGate.future, now: () => 1000);
  final pendingRef = await pendingManager.snapshot(approvedOnly: false);
  final pendingRotation = pendingManager.fresh(pendingRef);
  await Future<void>.delayed(Duration.zero);
  final approval = pendingManager.markApproved(pendingRef, {'accountSigningPrivateKey': 'sign',
    'accountEncryptionPrivateKey': 'box', 'contentKey': 'content'});
  await Future<void>.delayed(Duration.zero);
  assert(pendingStore.blocked && pendingStore.value!['deviceStatus'] == 'pending');
  rotationGate.complete(rotated());
  await pendingRotation;
  await approval;
  assert(!pendingStore.blocked && pendingStore.value!['deviceStatus'] == 'approved');
  assert(pendingStore.value!['accessToken'] == 'new' && pendingStore.value!['refreshToken'] == 'next');

  final manualStore = MemoryStore(credential());
  final manualGate = Completer<Map<String, dynamic>>();
  final manual = SessionManager(manualStore, (_) => manualGate.future, now: () => 1000);
  final manualRef = await manual.snapshot();
  final manualRotation = manual.fresh(manualRef);
  await Future<void>.delayed(Duration.zero);
  await manual.requireLogin();
  assert(!manual.isCurrent(manualRef) && manualStore.blocked);
  final manualRestart = SessionManager(manualStore, (_) async => rotated(), now: () => 1000);
  try { await manualRestart.snapshot(); throw StateError('manual login fence was not durable'); }
  on SignInRequired { /* Reopening the app must retain the login requirement. */ }
  await manual.replace(manual.generation, credential(expiry: 100000, token: 'manual-login'));
  manualGate.complete(rotated());
  try { await manualRotation; throw StateError('old rotation overwrote manual login'); }
  on SessionChanged { assert((await manual.snapshot()).credentials['accessToken'] == 'manual-login'); }

  final blockedStore = MemoryStore(credential(expiry: 100000));
  final blocked = SessionManager(blockedStore, (_) async => rotated(), now: () => 1000);
  final blockedRef = await blocked.snapshot();
  blockedStore.failBlock = true;
  var blockFailed = false;
  try { await blocked.requireLogin(); }
  on StateError { blockFailed = true; }
  assert(blockFailed && !blocked.isCurrent(blockedRef));
  try { await blocked.snapshot(); throw StateError('storage failure revived an old session'); }
  on SignInRequired { /* Failed persistence still invalidates in-memory consumers. */ }

  final readStore = MemoryStore(credential(expiry: 100000));
  final readManager = SessionManager(readStore, (_) async => rotated(), now: () => 1000);
  final readRef = await readManager.snapshot();
  final readGate = Completer<String>();
  final delayedRead = readManager.read(readRef, (_) => readGate.future);
  await Future<void>.delayed(Duration.zero);
  await readManager.requireLogin();
  readGate.complete('old response');
  try { await delayedRead; throw StateError('late response crossed the login fence'); }
  on SessionChanged { /* Responses from the previous session cannot update the login UI. */ }
  print('session contract smoke passed');
}
