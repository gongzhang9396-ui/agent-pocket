import 'dart:async';

/// Adapter must atomically persist the existing Android credential JSON.
abstract interface class CredentialStore {
  Future<Map<String, dynamic>?> load();
  Future<bool> isBlocked();
  Future<void> block();
  /// Saves credentials and clears the durable block in one atomic commit.
  Future<void> save(Map<String, dynamic> credentials);
  /// Clears credentials while setting a durable block in one atomic commit.
  Future<void> clearCredentials();
}

class SignInRequired implements Exception { @override String toString() => '登录已失效，请重新登录；原设备身份已保留'; }
class SessionChanged implements Exception { @override String toString() => '登录状态已变化，请刷新后继续'; }
class AccessRejected implements Exception { @override String toString() => '服务器拒绝了当前登录凭据'; }
class RefreshConsumed implements Exception {}
/// The transport can prove the request never left the device.
class RefreshNotSent implements Exception {}

class SessionRef {
  SessionRef(this.generation, Map<String, dynamic> credentials)
    : credentials = Map.unmodifiable(credentials);
  final int generation;
  final Map<String, dynamic> credentials;
}

typedef Refresh = Future<Map<String, dynamic>> Function(Map<String, dynamic>);

class SessionManager {
  SessionManager(this.store, this.refresh, {int Function()? now})
    : _now = now ?? (() => DateTime.now().millisecondsSinceEpoch);
  final CredentialStore store;
  final Refresh refresh;
  final int Function() _now;
  int _generation = 0;
  bool _requiresLogin = false;
  Future<void> _tail = Future.value();
  Future<Map<String, dynamic>>? _refreshInFlight;
  int? _refreshGeneration;
  int get generation => _generation;
  bool isCurrent(SessionRef ref) => ref.generation == _generation && !_requiresLogin;
  Future<void>? _initialization;

  Future<void> _initialize() => _initialization ??= () async {
    _requiresLogin = await store.isBlocked();
  }();

  Future<T> _locked<T>(Future<T> Function() action) async {
    final previous = _tail;
    final release = Completer<void>();
    _tail = release.future;
    await previous;
    try { return await action(); } finally { release.complete(); }
  }

  Future<SessionRef> snapshot({bool approvedOnly = true}) async {
    await _initialize();
    return _locked(() async {
    final value = await store.load();
    if (value == null || _requiresLogin || value['requiresLogin'] == true) throw SignInRequired();
    if (approvedOnly && (value['deviceStatus'] != 'approved' || (value['contentKey'] as String? ?? '').isEmpty)) {
      throw SignInRequired();
    }
    return SessionRef(_generation, value);
    });
  }

  Future<Map<String, dynamic>> _current(SessionRef ref) async {
    final value = await store.load();
    if (value == null || ref.generation != _generation ||
        ['endpoint', 'accountId', 'deviceId'].any((key) => value[key] != ref.credentials[key])) {
      throw SessionChanged();
    }
    if (_requiresLogin || value['requiresLogin'] == true) throw SignInRequired();
    return value;
  }

  Future<void> replace(int expectedGeneration, Map<String, dynamic> credentials) async {
    await _initialize();
    return _locked(() async {
    if (expectedGeneration != _generation) throw SessionChanged();
    _generation++;
    try { await store.block(); } catch (_) { _requiresLogin = true; rethrow; }
    try { await store.save({...credentials, 'requiresLogin': false}); _requiresLogin = false; }
    catch (_) {
      _requiresLogin = true;
      try { await store.save({...credentials, 'requiresLogin': true}); } catch (_) { /* preserve identity */ }
      rethrow;
    }
    });
  }

  Future<void> clear() => _locked(() async {
    _generation++;
    try { await store.block(); await store.clearCredentials(); _requiresLogin = true; }
    catch (_) { _requiresLogin = true; rethrow; }
  });

  Future<void> requireLogin() async {
    await _initialize();
    return _locked(() async {
      _generation++;
      _requiresLogin = true;
      await store.block();
    });
  }

  /// Commits a verified account package for a previously pending device.
  /// A concurrent token rotation must finish first: saving credentials also
  /// clears the durable rotation fence and must never run mid-refresh.
  Future<void> markApproved(SessionRef ref, Map<String, dynamic> secrets) async {
    for (final key in ['accountSigningPrivateKey', 'accountEncryptionPrivateKey', 'contentKey']) {
      if (secrets[key] is! String || (secrets[key] as String).isEmpty) throw const FormatException('账户密钥不完整');
    }
    while (true) {
      Future<Map<String, dynamic>>? rotating;
      final saved = await _locked(() async {
        final current = await _current(ref);
        rotating = _refreshGeneration == ref.generation ? _refreshInFlight : null;
        if (rotating != null) return false;
        if (current['deviceStatus'] != 'pending') throw SessionChanged();
        final updated = {...current, 'deviceStatus': 'approved',
          for (final key in ['accountSigningPrivateKey', 'accountEncryptionPrivateKey', 'contentKey']) key: secrets[key]};
        try { await store.save(updated); }
        catch (_) {
          _requiresLogin = true;
          try { await store.block(); } catch (_) { /* Keep the identity for recovery. */ }
          rethrow;
        }
        return true;
      });
      if (saved) return;
      await rotating!;
    }
  }

  Future<Never> _reject(SessionRef ref, {String? token}) => _locked(() async {
    final value = await _current(ref);
    if (token != null && value['accessToken'] != token) throw SessionChanged();
    _requiresLogin = true;
    var persisted = false;
    try { await store.block(); persisted = true; } catch (_) { /* try flagged credentials */ }
    try { await store.save({...value, 'requiresLogin': true}); persisted = true; } catch (_) { /* durable block remains */ }
    if (!persisted) throw StateError('无法保存失效状态，请检查手机存储空间');
    throw SignInRequired();
  });

  Future<Map<String, dynamic>> fresh(SessionRef ref, {String? rejectedToken}) async {
    final value = await _locked(() => _current(ref));
    if (_refreshInFlight != null && _refreshGeneration == ref.generation) return _refreshInFlight!;
    if ((value['accessExpiresAt'] as int? ?? 0) > _now() + 30000 && value['accessToken'] != rejectedToken) return value;
    if ((value['refreshExpiresAt'] as int? ?? 0) <= _now()) return _reject(ref, token: value['accessToken'] as String?);
    final pending = _rotate(ref, value);
    _refreshInFlight = pending; _refreshGeneration = ref.generation;
    try { return await pending; }
    finally { if (identical(_refreshInFlight, pending)) { _refreshInFlight = null; _refreshGeneration = null; } }
  }

  Future<Map<String, dynamic>> _rotate(SessionRef ref, Map<String, dynamic> original) async {
    // Persist a fence before sending the single-use refresh token. If the
    // process dies mid-rotation, the old token cannot be replayed on restart.
    await _locked(() async { await _current(ref); await store.block(); });
    Map<String, dynamic> rotated;
    try { rotated = await refresh(Map.unmodifiable(original)); }
    on AccessRejected { return _reject(ref, token: original['accessToken'] as String?); }
    on RefreshConsumed { return _reject(ref); }
    on RefreshNotSent {
      await _locked(() async {
        final current = await _current(ref);
        try { await store.save(current); } catch (_) { _requiresLogin = true; rethrow; }
      });
      rethrow;
    }
    catch (_) {
      await _locked(() async { await _current(ref); _requiresLogin = true; });
      rethrow;
    }
    if (rotated['accessToken'] is! String || (rotated['accessToken'] as String).isEmpty ||
        rotated['refreshToken'] is! String || (rotated['refreshToken'] as String).isEmpty ||
        rotated['accessExpiresAt'] is! int || (rotated['accessExpiresAt'] as int) <= _now() ||
        rotated['refreshExpiresAt'] is! int || (rotated['refreshExpiresAt'] as int) <= _now()) {
      return _reject(ref);
    }
    return _locked(() async {
      final current = await _current(ref);
      final updated = {...current, for (final key in ['accessToken', 'refreshToken', 'accessExpiresAt', 'refreshExpiresAt']) key: rotated[key]};
      try { await store.save(updated); } catch (_) {
        _requiresLogin = true;
        try { await store.save({...updated, 'requiresLogin': true}); } catch (_) { /* preserve identity */ }
        throw SignInRequired();
      }
      return updated;
    });
  }

  /// Only idempotent reads can be retried after a 401.
  Future<T> read<T>(SessionRef ref, Future<T> Function(Map<String, dynamic>) request) async {
    var value = await fresh(ref);
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        final result = await request(Map.unmodifiable(value));
        await _locked(() => _current(ref));
        return result;
      } on AccessRejected {
        if (attempt == 1) return _reject(ref, token: value['accessToken'] as String?);
        value = await fresh(ref, rejectedToken: value['accessToken'] as String?);
      }
    }
    throw StateError('unreachable');
  }
}
